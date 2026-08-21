/**
 * Runs inside Electron. Boots the real app, waits for the scripted transcript to
 * arrive over the fake sockets, then asserts on the rendered DOM.
 *
 * Assertions are about what is painted (getClientRects) rather than what an
 * attribute claims — an earlier bug in this project passed an attribute check
 * while the element was plainly visible on screen.
 */
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const PROFILE = process.env.OVERLAY_E2E_PROFILE;
const MEDIA = process.env.OVERLAY_E2E_MEDIA;
const PREFIX = process.env.OVERLAY_E2E_PREFIX || '';
const ONLY = process.env.OVERLAY_E2E_ONLY || '';
const SCENARIO = process.env.OVERLAY_E2E_SCENARIO || '';
app.setPath('userData', PROFILE);

// boot relaunches with this flag after quarantining a payload that threw. That
// second process exists only to prove the app comes back; the assertions about
// what was quarantined are made from run.mjs, against the files left behind.
if (process.argv.includes('--overlay-recovered')) {
  console.log('  (recovery launch)');
  app.exit(0);
}

/**
 * Links in the chat open in the real browser. A test run must not actually
 * launch one, and the only thing worth asserting is that the right url was
 * handed over — so the call is recorded here instead. This is the same
 * electron module instance the app's main process requires, so the app's own
 * `shell:open` handler ends up here.
 */
const { shell } = require('electron');
const openedLinks = [];
const realOpenExternal = shell.openExternal;
shell.openExternal = (url) => { openedLinks.push(url); return Promise.resolve(); };
if (shell.openExternal === realOpenExternal) {
  console.log('E2E FAIL: could not intercept shell.openExternal');
  app.exit(1);
}

require(path.join(__dirname, '..', '..', 'app', 'boot.js'));

const failures = [];
const check = (name, ok, detail) => {
  if (ok) console.log(`  ok  ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
    failures.push(name);
  }
};

let win = null;
const consoleErrors = [];
const findWindow = setInterval(() => {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) return;
  clearInterval(findWindow);
  win = w;
  w.webContents.on('console-message', (...args) => {
    const ev = args[0];
    const message = ev && typeof ev === 'object' && 'message' in ev ? ev.message : args[1];
    const level = ev && typeof ev === 'object' && 'level' in ev ? ev.level : args[0];
    if (String(level).match(/error|^3$/)) consoleErrors.push(String(message));
  });
  w.webContents.on('preload-error', (_e, _f, err) => consoleErrors.push('preload: ' + err.message));
  w.webContents.on('render-process-gone', (_e, d) => consoleErrors.push('render gone: ' + JSON.stringify(d)));
}, 25);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (js) => win.webContents.executeJavaScript(js);

/**
 * Put the window under the real pointer, or as far from it as the display
 * allows.
 *
 * Hover cannot be faked here. Synthetic mouseLeave does not clear `:hover`
 * while the operating system's own cursor is sitting over the window, which
 * made the backdrop checks pass or fail depending on where the mouse happened
 * to be left. Moving the window is the one thing that settles it, and it
 * exercises the real hover rule rather than working around it.
 */
function covers(bounds, pt) {
  return pt.x >= bounds.x && pt.x < bounds.x + bounds.width
    && pt.y >= bounds.y && pt.y < bounds.y + bounds.height;
}

/**
 * Move the window, then confirm it actually landed where the pointer needs it.
 *
 * A window manager is free to clamp or ignore setPosition, and the cursor can
 * be anywhere on a multi-monitor desktop, so "I asked for it" is not the same
 * as "it happened". Verifying here turns a mysterious intermittent hover
 * failure into a clear one about the window placement.
 */
async function placeWindowVerified(where, tries = 8) {
  for (let i = 0; i < tries; i++) {
    placeWindow(where);
    await wait(120);
    const ok = covers(win.getBounds(), screen.getCursorScreenPoint());
    if (ok === (where === 'under')) return true;
  }
  return false;
}

function placeWindow(where) {
  const pt = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(pt).workArea;
  const [w, h] = win.getSize();
  if (where === 'under') {
    // Clamped into the work area, then nudged so the pointer is still inside:
    // a window shoved back on screen can end up beside the cursor, not under it.
    const x = Math.min(Math.max(Math.round(pt.x - w / 2), area.x), Math.max(area.x, area.x + area.width - w));
    const y = Math.min(Math.max(Math.round(pt.y - h / 2), area.y), Math.max(area.y, area.y + area.height - h));
    win.setPosition(x, y);
  } else {
    // The first placement that provably excludes the pointer. A window nearly
    // as tall as the display cannot dodge it by moving to a corner, so the
    // last candidates push it off the screen edge entirely.
    const inside = (x, y) => pt.x >= x && pt.x < x + w && pt.y >= y && pt.y < y + h;
    const candidates = [
      [area.x + area.width - w, area.y + area.height - h],
      [area.x, area.y],
      [area.x - w + 8, area.y],
      [area.x + area.width - 8, area.y],
    ];
    const [x, y] = candidates.find(([cx, cy]) => !inside(cx, cy)) ?? candidates[2];
    win.setPosition(Math.round(x), Math.round(y));
  }
  // Chromium re-evaluates hover on the next mouse event, so nudge it.
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(w / 2), y: Math.round(h / 2) });
}

/**
 * Poll a page expression until it holds, up to `ms`.
 *
 * Synthetic mouse events and CSS transitions both settle asynchronously, and
 * how long they take depends on the display server. A fixed sleep is either
 * flaky or slow; this is neither, and still fails if the state never arrives.
 */
const until = async (js, ms = 3000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await q(js)) return true;
    if (Date.now() > deadline) return false;
    await wait(50);
  }
};
/** until(), for state that lives in this process rather than in the page. */
const untilLocal = async (fn, ms = 3000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > deadline) return false;
    await wait(50);
  }
};

const snap = async (name) => {
  if (!MEDIA) return;
  // capturePage can hand back the frame before the last change was composited,
  // which once produced a "settings" screenshot showing the chat.
  await wait(400);
  fs.mkdirSync(MEDIA, { recursive: true });
  fs.writeFileSync(path.join(MEDIA, PREFIX + name), (await win.capturePage()).toPNG());
};

/** Painted, not merely styled: the alert is display:none when there is none. */
const ALERT_PAINTED = `document.getElementById('src-alert').getClientRects().length > 0`;
const ALERT_TEXT = `JSON.stringify(document.getElementById('alert-text').textContent)`;
const DOTS = `JSON.stringify(Array.from(document.querySelectorAll('#status .src-dot')).map((d) => d.className))`;
const MSGS = `document.querySelectorAll('.msg[data-platform]').length`;

/**
 * The socket is cut mid-transcript, without a close frame. Nobody has to press
 * anything: the source backs off, reconnects, and the feed carries on. Real
 * chat connections drop several times an evening, and the happy-path run never
 * sees it.
 */
async function scenarioDrop() {
  check('connected before the drop', await until(`${DOTS}.includes('online')`, 15000));
  const before = Number(await q(MSGS));
  check('messages arriving before the drop', before > 0, `msgs=${before}`);

  // The server terminates both sockets 4s in.
  check('the drop is noticed, not sat on',
    await until(`!JSON.parse(${DOTS}).every((c) => c.includes('online'))`, 15000),
    await q(DOTS));
  check('the status says it is retrying',
    await until(`Array.from(document.querySelectorAll('#status .src-dot')).some((d) => /retry|connecting|error/.test(d.title))`, 15000),
    await q(`JSON.stringify(Array.from(document.querySelectorAll('#status .src-dot')).map((d) => d.title))`));

  check('the bar says so without being hovered',
    await until(`${ALERT_PAINTED}`, 15000), await q(ALERT_TEXT));
  // Locked, the bar is not there at all and the feed is the only surface left.
  // A connection coming back has always written a line; one going away wrote
  // nothing, so the feed's last word on a dead channel was "connected".
  check('the feed says a working connection went away',
    await until(`/lost — (twitch|goodgame)\\//.test(document.body.textContent)`, 15000),
    await q(`document.body.textContent.slice(-200)`));
  check('and says the feed has stopped, not that one channel has',
    await until(`${ALERT_TEXT} === '"all channels offline"'`, 15000), await q(ALERT_TEXT));

  check('it reconnects on its own',
    await until(`JSON.parse(${DOTS}).every((c) => c.includes('online'))`, 40000),
    await q(DOTS));
  check('the feed carries on after reconnecting',
    await until(`${MSGS} > ${before}`, 30000),
    `before=${before} after=${await q(MSGS)}`);
  // Recovering is instant — the bar goes quiet the moment there is nothing to
  // report, without waiting out the grace it uses before complaining.
  check('the bar goes quiet again once it is back',
    await until(`!(${ALERT_PAINTED})`, 5000), await q(ALERT_TEXT));
}

/**
 * The case ws.onclose cannot see: the sockets stay open and simply stop
 * carrying anything, in either direction. No close frame is sent, so nothing
 * fires and the transport still looks healthy — a laptop waking from sleep, a
 * Wi-Fi handover, a NAT timeout. Only the sources' own watchdog can tell this
 * apart from a channel where nobody happens to be talking, which is the normal
 * state of most channels and why it has to ask before it gives up.
 */
async function scenarioStall() {
  check('connected before the stall', await until(`${DOTS}.includes('online')`, 15000));
  const before = Number(await q(MSGS));
  check('messages arriving before the stall', before > 0, `msgs=${before}`);

  // The server goes silent 4s in and stops answering probes, without closing.
  check('the silence is noticed, not sat on',
    await until(`!JSON.parse(${DOTS}).every((c) => c.includes('online'))`, 25000),
    await q(DOTS));
  check('the feed says why, so it is not mistaken for a quiet channel',
    await until(`/no reply/.test(document.body.textContent)`, 25000),
    await q(`document.body.textContent.slice(-200)`));
  check('the status says it is retrying',
    await until(`Array.from(document.querySelectorAll('#status .src-dot')).some((d) => /retry|connecting|error/.test(d.title))`, 15000),
    await q(`JSON.stringify(Array.from(document.querySelectorAll('#status .src-dot')).map((d) => d.title))`));

  // Counted after the silence was noticed, not before it: everything that
  // arrives from here can only have come over a socket that was reconnected.
  const atStall = Number(await q(MSGS));
  check('it reconnects on its own',
    await until(`JSON.parse(${DOTS}).every((c) => c.includes('online'))`, 40000),
    await q(DOTS));
  check('the feed carries on after reconnecting',
    await until(`${MSGS} > ${atStall}`, 30000),
    `atStall=${atStall} after=${await q(MSGS)}`);
}

/**
 * A YouTube channel that is not live.
 *
 * The state neither socket has: nothing is broken, there is simply no stream to
 * read yet, and most channels are in it most of the time. The overlay has to say
 * so — while locked the feed is the only surface it has — keep asking on its own
 * slow cadence, and connect itself when the stream starts, with nobody pressing
 * anything. The server starts serving a live page six seconds in.
 */
async function scenarioYtOffline() {
  check('the other two connect regardless',
    await until(`JSON.parse(${DOTS}).filter((c) => c.includes('online')).length >= 2`, 20000),
    await q(DOTS));

  check('the feed says the channel is not live, rather than leaving it blank',
    await until(`/not live — youtube\\/@northlight/.test(document.body.textContent)`, 15000),
    await q(`document.body.textContent.slice(-300)`));
  check('and the dot says idle rather than error or offline',
    await until(`Array.from(document.querySelectorAll('#status .src-dot')).some((d) => /yt\\/@northlight — idle — not live/.test(d.title))`, 15000),
    await q(`JSON.stringify(Array.from(document.querySelectorAll('#status .src-dot')).map((d) => d.title))`));

  // Six seconds in the channel goes live. Nothing is pressed.
  check('it connects by itself once the channel goes live',
    await until(`/connected — youtube\\/@northlight/.test(document.body.textContent)`, 30000),
    await q(`document.body.textContent.slice(-300)`));
  check('and the chat then arrives',
    await until(`document.querySelectorAll('.msg[data-platform="youtube"]').length > 0`, 20000));
  check('every channel is online in the end',
    await until(`JSON.parse(${DOTS}).every((c) => c.includes('online'))`, 20000), await q(DOTS));

  // It said it once, not once per check — the cadence must not become a log.
  const said = Number(await q(`(document.body.textContent.match(/not live — youtube/g) || []).length`));
  check('it said so once, not on every re-check', said === 1, `said=${said}`);
}

/**
 * A YouTube stream that ends while the overlay is open.
 *
 * Not silence — the poll is answered, and answered correctly, with no
 * continuation left to follow. That is a positive signal that the chat is over,
 * so it goes out through the same door every other disconnect uses instead of
 * waiting on a watchdog, and then the source starts looking again.
 */
async function scenarioYtEnded() {
  check('youtube connects and delivers chat first',
    await until(`document.querySelectorAll('.msg[data-platform="youtube"]').length > 0`, 20000),
    await q(`document.querySelectorAll('.msg[data-platform="youtube"]').length`));
  const before = Number(await q(`document.querySelectorAll('.msg[data-platform="youtube"]').length`));

  // Four seconds in the server stops offering a continuation.
  check('the end of the stream is noticed at once, not waited out',
    await until(`/lost — youtube\\/@northlight/.test(document.body.textContent)`, 20000),
    await q(`document.body.textContent.slice(-300)`));
  check('the messages already on screen are left alone',
    Number(await q(`document.querySelectorAll('.msg[data-platform="youtube"]').length`)) >= before,
    `before=${before}`);
  check('and it goes back to looking rather than giving up',
    await until(`/not live — youtube\\/@northlight/.test(document.body.textContent)`, 25000),
    await q(`document.body.textContent.slice(-300)`));

  /*
   * And the bar says nothing about it. A channel that is not streaming is the
   * resting state of most channels most of the time; painting it as a failure
   * would leave a permanent alert over the game for the ordinary case, which
   * is the one thing this bar is designed never to do. Waited out past the
   * alert's own grace, so this is the settled answer and not a gap in it.
   */
  // Read in one expression: the dot and the alert are written by the same
  // render, so asking twice could straddle one and report a state that never
  // existed. The harness re-checks a not-live channel every two seconds, and
  // each check is a real `connecting` moment the alert's own grace swallows —
  // which is why the text is asserted here rather than only what is painted.
  const IDLE_AND_ALERT = `JSON.stringify([
    Array.from(document.querySelectorAll('#status .src-dot')).some((d) => /idle/.test(d.className)),
    document.getElementById('alert-text').textContent])`;
  check('the bar says nothing at all while the channel is merely not live',
    await until(`${IDLE_AND_ALERT} === '[true,""]'`, 15000), await q(IDLE_AND_ALERT));
  await wait(5000);
  check('and it draws nothing, rather than reappearing on the next re-check',
    !(await q(ALERT_PAINTED)), await q(ALERT_TEXT));

  check('the other two carry on throughout',
    await until(`JSON.parse(${DOTS}).filter((c) => c.includes('online')).length >= 2`, 20000),
    await q(DOTS));
}

/* ------------------------------------------------------------------ burst --
 *
 * The load a busy channel puts on the renderer, which no socket transcript
 * reproduces. YouTube is a poll: one answer carries every message since the
 * last one, so a channel like the one this was reported on hands the app two
 * or three hundred messages in a single callback. Twitch and GoodGame trickle
 * one per frame and always have, which is why rendering one message at a time
 * survived this long.
 *
 * Measured rather than asserted about. The numbers printed here are the ones
 * quoted in the changeset, and they come out of a real Electron rendering real
 * messages, not out of a benchmark harness pretending to be one.
 */

const API = process.env.OVERLAY_TEST_API_BASE || '';

/** Arm a burst; the fake server sends it on the next poll. */
function armBurst({ n, tag, moderate = false }) {
  return new Promise((resolve, reject) => {
    const url = `${API}/e2e/burst?n=${n}&tag=${tag}&moderate=${moderate ? 1 : 0}`;
    require('node:http').get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

/**
 * What the renderer actually did, counted by the browser itself.
 *
 * LayoutCount is Chromium's own tally of layout runs — the thing a read of
 * scrollHeight between two DOM writes forces. It is read over the burst window
 * only, so it is the cost of this batch and not of the session.
 */
let debuggerAttached = false;
async function chromeMetrics() {
  if (!debuggerAttached) {
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Performance.enable');
    debuggerAttached = true;
  }
  const { metrics } = await win.webContents.debugger.sendCommand('Performance.getMetrics');
  const by = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  return { layouts: by.LayoutCount, recalcs: by.RecalcStyleCount, layoutMs: by.LayoutDuration * 1000 };
}

/**
 * A recorder inside the page: how the feed was written to, and how long the
 * main thread was unavailable while it happened.
 *
 * The mutation records are the direct measure of the bug — one record per
 * appended node is one-at-a-time; one record carrying the whole batch is one
 * go. The frame gap is what the user sees: the longest stretch where nothing
 * could be painted because the renderer was busy.
 */
const RECORDER = `(() => {
  const rec = { records: 0, added: 0, removed: 0, maxAdded: 0, maxFrameGap: 0, frames: 0, live: true };
  window.__burst = rec;
  const mo = new MutationObserver((list) => {
    for (const r of list) {
      if (r.addedNodes.length) {
        rec.records++;
        rec.added += r.addedNodes.length;
        rec.maxAdded = Math.max(rec.maxAdded, r.addedNodes.length);
      }
      rec.removed += r.removedNodes.length;
    }
  });
  mo.observe(document.getElementById('chat'), { childList: true });
  let last = performance.now();
  const tick = (t) => {
    rec.frames++;
    rec.maxFrameGap = Math.max(rec.maxFrameGap, t - last);
    last = t;
    if (rec.live) requestAnimationFrame(tick); else mo.disconnect();
  };
  requestAnimationFrame(tick);
  return true;
})()`;

const STOP_RECORDER = `(() => { window.__burst.live = false; return JSON.stringify(window.__burst); })()`;

/** The ordinals painted, read off the message text the burst wrote. */
const ORDINALS = (tag) => `Array.from(document.querySelectorAll('.msg[data-platform="youtube"] .text'))
  .map((t) => /^${tag} (\\d+)$/.exec(t.textContent))
  .filter(Boolean).map((m) => Number(m[1]))`;

const SCROLL = `JSON.stringify((() => {
  const c = document.getElementById('chat');
  return { top: c.scrollTop, height: c.scrollHeight, client: c.clientHeight,
           fromBottom: c.scrollHeight - c.clientHeight - c.scrollTop };
})())`;

async function scenarioBurst() {
  const cfg = await q(`window.overlay.getConfig()`);
  const MAX = cfg.maxMessages;
  check('the run is configured with the shipped message cap', MAX === 120, `maxMessages=${MAX}`);

  check('youtube is connected before the burst',
    await until(`document.querySelectorAll('.msg[data-platform="youtube"]').length > 0`, 25000));
  // Let the scripted transcript finish, so the burst is measured on its own.
  await wait(11000);
  const settled = Number(await q(MSGS));
  check('the ordinary transcript rendered first', settled > 0, `msgs=${settled}`);

  /* --------------------------------------------------------- the burst -- */
  const N = 300;
  await q(RECORDER);
  const before = await chromeMetrics();
  const t0 = Date.now();
  await armBurst({ n: N, tag: 'burst', moderate: true });
  // 300 lines, four of them moderated away, against a 120 cap: the feed ends
  // up holding exactly the cap, all of it from the burst.
  const arrived = await until(`(${ORDINALS('burst')}).length >= 100`, 30000);
  await wait(600);
  const after = await chromeMetrics();
  const rec = JSON.parse(await q(STOP_RECORDER));
  const elapsed = Date.now() - t0;

  const metrics = {
    messages: N,
    layouts: Math.round(after.layouts - before.layouts),
    recalcs: Math.round(after.recalcs - before.recalcs),
    layoutMs: Math.round((after.layoutMs - before.layoutMs) * 10) / 10,
    appendRecords: rec.records,
    nodesAppended: rec.added,
    nodesRemoved: rec.removed,
    largestAppend: rec.maxAdded,
    maxFrameGapMs: Math.round(rec.maxFrameGap),
    wallMs: elapsed,
  };
  console.log('\nBURST METRICS ' + JSON.stringify(metrics));

  check('the burst arrived at all', arrived, JSON.stringify(metrics));

  /* ------------------------------------------------ what must not break -- */
  const ordinals = await q(ORDINALS('burst'));
  const painted = Number(await q(MSGS));
  check('the cap holds exactly', painted === MAX, `painted=${painted} max=${MAX}`);
  // 300 arrive against a 120 cap, so the last 120 arrivals are the ones kept —
  // four of which the moderator took down inside the same batch. The feed is
  // still full: the gap is made up by the four newest messages from before the
  // burst, which is what a cap holding exactly means.
  check('the burst fills the feed and the older messages are trimmed away',
    ordinals.length === MAX - 4, `burst=${ordinals.length} painted=${painted}`);
  check('messages are in arrival order',
    ordinals.every((v, i) => i === 0 || v > ordinals[i - 1]), JSON.stringify(ordinals.slice(0, 8)));
  check('the newest message of the burst is the last one on screen',
    ordinals[ordinals.length - 1] === Math.max(...ordinals), JSON.stringify(ordinals.slice(-3)));

  // Moderation inside the same batch as the messages it acts on. Both the
  // timeout and the ban name lines that are in the surviving tail, so a
  // renderer that applied them only to what was already on screen leaves them
  // up — which is the bug a queue makes possible and must not have.
  const moderated = JSON.parse(await q(`JSON.stringify({
    doomed: Array.from(document.querySelectorAll('.msg[data-platform="youtube"] .name')).filter((n) => n.textContent === '@doomed').length,
    troll: Array.from(document.querySelectorAll('.msg[data-platform="youtube"] .name')).filter((n) => n.textContent === '@troll').length
  })`));
  check('a timeout in the same batch takes its message down before it is painted',
    moderated.doomed === 0, `doomed=${moderated.doomed}`);
  check('and a ban in the same batch takes every one of that author down',
    moderated.troll === 0, `troll=${moderated.troll}`);

  // The whole point: one write, not three hundred.
  check('the batch is written to the feed in one go, not one message at a time',
    rec.records <= 5 && rec.maxAdded >= 100,
    `records=${rec.records} largest=${rec.maxAdded}`);
  // 300 arrive, 120 can be on screen. Building the other 180 only to delete
  // them is work nobody ever sees.
  check('messages the cap will delete are never built',
    rec.added <= MAX + 10, `appended=${rec.added} max=${MAX}`);
  check('the renderer does not force a layout per message',
    metrics.layouts < N / 4, `layouts=${metrics.layouts} for ${N} messages`);

  /* ------------------------------------------------------------ scroll -- */
  const pinned = JSON.parse(await q(SCROLL));
  check('someone at the bottom stays pinned to it', pinned.fromBottom < 24, JSON.stringify(pinned));

  await q(`document.getElementById('chat').scrollTop = 0; true`);
  // The scroll listener is what turns auto-scroll off, and it runs off the
  // event rather than the assignment.
  check('scrolling up is registered', await until(`JSON.parse(${SCROLL}).fromBottom >= 24`, 3000));
  await armBurst({ n: 30, tag: 'later' });
  check('the later burst arrived', await until(`(${ORDINALS('later')}).length > 0`, 20000));
  await wait(600);
  const readingBack = JSON.parse(await q(SCROLL));
  check('a user who has scrolled up is not yanked to the bottom',
    readingBack.fromBottom >= 24, JSON.stringify(readingBack));

  await q(`(() => { const c = document.getElementById('chat'); c.scrollTop = c.scrollHeight; return true; })()`);
  check('scrolling back down is registered', await until(`JSON.parse(${SCROLL}).fromBottom < 24`, 3000));
  await armBurst({ n: 30, tag: 'again' });
  check('the third burst arrived', await until(`(${ORDINALS('again')}).length > 0`, 20000));
  await wait(600);
  const backAtBottom = JSON.parse(await q(SCROLL));
  check('and someone who came back to the bottom is carried along again',
    backAtBottom.fromBottom < 24, JSON.stringify(backAtBottom));

  /* ---------------------------------------------------------- lifetime -- */
  // A coalesced message still expires. Set the lifetime to a second, burst,
  // and the burst must appear and then go.
  // The slider steps in fives, so five seconds is the shortest life there is.
  await q(`(() => {
    const s = document.getElementById('messageLifetime');
    s.value = '5';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await armBurst({ n: 30, tag: 'brief' });
  check('messages with a lifetime are painted',
    await until(`(${ORDINALS('brief')}).length > 0`, 20000));
  check('and then fade out on their own',
    await until(`(${ORDINALS('brief')}).length === 0`, 25000),
    await q(`(${ORDINALS('brief')}).length`));
}

/* ----------------------------------------------------------------- rhythm --
 *
 * A measurement first and a regression guard second. Coalescing fixed what a
 * poll's answer *costs*; this is about the shape it arrives in. YouTube hands
 * over everything said since the last answer, so a busy channel used to land
 * ten lines in a single frame and then show nothing at all for the rest of the
 * interval — over and over, at a little under one clump a second.
 *
 * The numbers below come out of a real Electron rendering real messages
 * against a fake channel answered at 1300ms, which is what YouTube asks a busy
 * chat to wait. Before pacing, at eight messages a second:
 *
 *     msgPerWrite 9.6   jumpMedianPx 246   gapMedianMs 1304
 *
 * and at thirty a second, 33.1 messages and 883px in one frame — more than the
 * window is tall, so lines appeared and were scrolled past without ever being
 * painted once. After:
 *
 *     msgPerWrite 1     jumpMedianPx 25    gapMedianMs 84
 *
 * which is what a socket has always looked like.
 */

/** Arm a steady arrival rate on the fake server. */
function armRate({ n, every, secs, tag }) {
  return new Promise((resolve, reject) => {
    const url = `${API}/e2e/rate?n=${n}&every=${every}&secs=${secs}&tag=${tag}`;
    require('node:http').get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

/** Every write into the feed: when it happened, how much it carried, how far it moved the text. */
const TIMELINE = `(() => {
  const c = document.getElementById('chat');
  const rec = { writes: [] };
  window.__rhythm = rec;
  // scrollHeight is read after the feed's own painted() has already forced the
  // layout for this frame, so it costs nothing extra and is the number that
  // matters: how far the text under the reader's eye moved in one go.
  let height = c.scrollHeight;
  const mo = new MutationObserver((list) => {
    let n = 0;
    for (const r of list) n += r.addedNodes.length;
    const h = c.scrollHeight;
    const grew = Math.max(0, h - height);
    height = h;
    if (n > 0) rec.writes.push([Math.round(performance.now()), n, grew]);
  });
  mo.observe(c, { childList: true });
  rec.stop = () => mo.disconnect();
  return true;
})()`;

const STOP_TIMELINE = `(() => { window.__rhythm.stop(); return JSON.stringify(window.__rhythm.writes); })()`;

function describeWrites(writes) {
  const counts = writes.map((w) => w[1]);
  const jumps = writes.map((w) => w[2]).filter((v) => v > 0);
  const gaps = [];
  for (let i = 1; i < writes.length; i++) gaps.push(writes[i][0] - writes[i - 1][0]);
  const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  return {
    messages: sum(counts),
    writes: writes.length,
    msgPerWrite: Math.round((sum(counts) / counts.length) * 10) / 10,
    maxPerWrite: Math.max(...counts),
    // How far the feed scrolled in the single frame a write was made in.
    jumpMedianPx: pct(jumps, 0.5),
    jumpMaxPx: Math.max(...jumps),
    gapMedianMs: pct(gaps, 0.5),
    gapP90Ms: pct(gaps, 0.9),
    gapMaxMs: Math.max(...gaps),
    spanMs: writes[writes.length - 1][0] - writes[0][0],
  };
}

/**
 * Let a channel talk steadily for a while and record what the feed did.
 *
 * The arrivals are driven server-side rather than from here, so what the app
 * sees is the poll's own lumps and not this harness's HTTP jitter.
 */
async function measureRate({ label, perSec, secs }) {
  const every = Math.round(1000 / perSec);
  await q(TIMELINE);
  await armRate({ n: 1, every, secs, tag: 'flow' });
  await wait(secs * 1000 + 2500);
  const stats = describeWrites(JSON.parse(await q(STOP_TIMELINE)));
  console.log(`RHYTHM ${label} (${perSec}/s over ${secs}s) ` + JSON.stringify(stats));
  return { ...stats, armed: Math.round((secs * 1000) / every), secs };
}

const POLL_MS = 1300;

async function scenarioRhythm() {
  check('youtube is connected', await until(
    `document.querySelectorAll('.msg[data-platform="youtube"]').length > 0`, 25000));
  // Let the scripted transcript finish, so each rate is measured on its own.
  await wait(11000);

  const quiet = await measureRate({ label: 'quiet   ', perSec: 1, secs: 8 });
  const busy = await measureRate({ label: 'busy    ', perSec: 8, secs: 10 });
  const veryBusy = await measureRate({ label: 'veryBusy', perSec: 30, secs: 8 });
  console.log('\nRHYTHM SUMMARY ' + JSON.stringify({ quiet, busy, veryBusy }));

  for (const [name, r] of [['quiet', quiet], ['busy', busy], ['veryBusy', veryBusy]]) {
    // Smoothing that loses messages is not smoothing. The cap is well above
    // anything a single answer carries here, so every armed line must arrive.
    check(`${name}: not one message is lost`,
      r.messages >= r.armed && r.messages <= r.armed + 3,
      `arrived=${r.messages} armed=${r.armed}`);
    // The whole point: a lump becomes a trickle. Two per write is a frame that
    // happened to fall between two due messages, not a clump.
    check(`${name}: the feed is written a message at a time, not in a lump`,
      r.maxPerWrite <= 3, `maxPerWrite=${r.maxPerWrite} msgPerWrite=${r.msgPerWrite}`);
    // Before pacing this was 246px at eight a second and 883px at thirty —
    // half a window and more than a window, in a single frame.
    check(`${name}: and never jumps more than a line or two at once`,
      r.jumpMaxPx <= 80, `jumpMaxPx=${r.jumpMaxPx} jumpMedianPx=${r.jumpMedianPx}`);
    // Chat that is smooth but late is worse than chat that clumps. The window
    // is 70% of the interval and capped at a second, so the last message of a
    // batch is out well before the next batch lands.
    check(`${name}: and nothing is held past the interval it arrived in`,
      r.spanMs <= r.secs * 1000 + 2 * POLL_MS,
      `span=${r.spanMs} armed over=${r.secs * 1000}`);
  }

  // The reason this matters at all: at rest the feed used to do nothing for
  // more than a second between clumps, at a little under one a second.
  check('a busy channel flows rather than strobing',
    busy.gapMedianMs < POLL_MS / 3, `gapMedianMs=${busy.gapMedianMs}`);
  check('and a very busy one flows faster still',
    veryBusy.gapMedianMs < busy.gapMedianMs,
    `busy=${busy.gapMedianMs} veryBusy=${veryBusy.gapMedianMs}`);
  // A channel nobody is talking on has no rhythm to smooth, and must not be
  // made to wait for one: a lone message is painted in the frame it arrives in.
  check('a quiet channel is not paced at all',
    quiet.maxPerWrite === 1 && quiet.jumpMaxPx <= 80,
    JSON.stringify(quiet));

  const held = Number(await q(MSGS));
  check('and the feed is still holding chat at the end of it', held > 0, `msgs=${held}`);
}

const stateFile = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROFILE, 'payload-state.json'), 'utf8'));
  } catch {
    return null;
  }
};

/**
 * A payload downloaded by the updater has to actually be the one that runs,
 * and boot has to notice it worked. Nothing else in the suite runs boot's
 * decisions in a real process — and they decide which app you get.
 */
async function scenarioStaged() {
  const info = await q(`window.overlay.updateVersion()`);
  check('the downloaded payload is the one running', info.usingStaged === true, JSON.stringify(info));
  check('and it is the version that was staged', info.version === '99.0.0', JSON.stringify(info));
  check('the bundled version is still there underneath',
    !!info.bundled && info.bundled !== '99.0.0', JSON.stringify(info));

  check('the staged directory was installed, and the incoming one consumed',
    fs.existsSync(path.join(PROFILE, 'payload')) && !fs.existsSync(path.join(PROFILE, 'payload-new')));

  // markHealthy() runs when the renderer reports in; until then every launch
  // counts against the payload.
  check('the launch counter is cleared once the renderer comes up',
    await until(`true`, 1) && (() => {
      const s = stateFile();
      return s && s.version === '99.0.0' && s.trials === 0;
    })(), JSON.stringify(stateFile()));

  check('and the app works: messages are rendering', await until(`${MSGS} > 0`, 20000));
}

/**
 * The same payload after three launches that never reported in. Whatever is
 * wrong with it, boot must stop choosing it and fall back — this is what keeps
 * a bad release from bricking an install.
 */
async function scenarioTrials() {
  const info = await q(`window.overlay.updateVersion()`);
  check('the failing payload is not running', info.usingStaged === false, JSON.stringify(info));
  check('the bundled version is', info.version === info.bundled, JSON.stringify(info));

  const state = stateFile();
  check('it is recorded as quarantined', state?.quarantined?.version === '99.0.0', JSON.stringify(state));
  check('with the reason kept', /failed to start/.test(state?.quarantined?.reason ?? ''),
    JSON.stringify(state?.quarantined));
  check('the directory is moved aside, not left installed',
    !fs.existsSync(path.join(PROFILE, 'payload')) && fs.existsSync(path.join(PROFILE, 'payload-broken')));
  check('and the app is perfectly usable on the bundled payload',
    await until(`${MSGS} > 0`, 20000));
}

/**
 * Every emote/badge/icon provider unreachable. They are an enhancement; losing
 * them must not cost a single message.
 */
async function scenarioDegraded() {
  check('chat still connects with every catalogue down',
    await until(`JSON.parse(${DOTS}).every((c) => c.includes('online'))`, 20000), await q(DOTS));
  check('messages still render', await until(`${MSGS} >= 20`, 20000), `msgs=${await q(MSGS)}`);
  const state = JSON.parse(await q(`JSON.stringify({
    native: document.querySelectorAll('.msg img.emote[src*="/emoticons/v2/"]').length,
    thirdParty: document.querySelectorAll('.msg img.emote:not([src*="/emoticons/v2/"]):not([src*="/yt-emotes/"])').length,
    ytEmotes: document.querySelectorAll('.msg img.emote[src*="/yt-emotes/"]').length,
    ytBadgeArt: document.querySelectorAll('.msg img.badge-img[src*="/yt-badges/"]').length,
    twitchBadges: document.querySelectorAll('.msg img.badge-img[src*="/twitch-badges/"]').length,
    ggBadges: document.querySelectorAll('.msg img.badge-img[src*="/gg-icons/"], .msg img.badge-img[src*="/files/icons/"]').length,
    chips: document.querySelectorAll('.msg .badge').length,
    twRoleIcons: document.querySelectorAll('.msg[data-platform="twitch"] img.badge-img[src*="/assets/badge-"]').length,
    broken: Array.from(document.querySelectorAll('.msg img')).filter((i) => i.complete && i.naturalWidth === 0).length,
    text: document.querySelector('.msg[data-platform] .text') ? document.querySelector('.msg[data-platform] .text').textContent : ''
  })`));
  // A catalogue outage costs the catalogues, and nothing else. Twitch sends its
  // own emotes as ranges on the message, so those keep working; 7TV, BTTV, FFZ
  // and GoodGame's smiles are lookups, so those quietly do not happen.
  check("twitch's own emotes survive — they need no catalogue", state.native > 0, `native=${state.native}`);
  check('third-party emotes are simply absent', state.thirdParty === 0, `thirdParty=${state.thirdParty}`);
  // Twitch badge artwork is fetched per channel, so it goes; GoodGame builds
  // its icon urls straight from the message, so it stays.
  check('twitch badge artwork is absent', state.twitchBadges === 0, `twitchBadges=${state.twitchBadges}`);
  check('goodgame icons survive — they need no catalogue either',
    state.ggBadges > 0, `ggBadges=${state.ggBadges}`);
  // YouTube has no catalogue at all: every emote and membership badge arrives
  // with its artwork url on the message, so an outage of every provider costs
  // it nothing. This is the assertion that would fail first if a catalogue
  // lookup were ever introduced there.
  check('youtube is untouched — it has no catalogue to lose',
    state.ytEmotes > 0 && state.ytBadgeArt > 0,
    `ytEmotes=${state.ytEmotes} ytBadgeArt=${state.ytBadgeArt}`);
  // Which is the point of keeping the text chips as a fallback: a subscriber or
  // a VIP badge is per-channel artwork nobody else has, so it becomes text.
  check('twitch badges degrade to text chips', state.chips > 0, `chips=${state.chips}`);
  // The two roles are the exception, because the app ships those two pictures.
  // A Twitch moderator normally draws Twitch's own sword; with the mirror down
  // it draws ours, which is the same symbol, rather than dropping to letters.
  check('twitch roles fall back to the bundled artwork, not to text',
    state.twRoleIcons >= 2, `twRoleIcons=${state.twRoleIcons}`);
  check('no broken images left on screen', state.broken === 0, `broken=${state.broken}`);
  check('the message text itself is intact', state.text.length > 0, JSON.stringify(state.text));
}

const HARD_TIMEOUT_MS = 180000;
setTimeout(() => {
  console.log(`\nE2E FAIL: the driver ran past ${HARD_TIMEOUT_MS / 1000}s`);
  app.exit(1);
}, HARD_TIMEOUT_MS).unref();

app.whenReady().then(async () => {
  await wait(1500);
  if (!win) { console.log('E2E FAIL: no window'); app.exit(1); return; }

  if (SCENARIO) {
    if (SCENARIO === 'drop') await scenarioDrop();
    else if (SCENARIO === 'stall') await scenarioStall();
    else if (SCENARIO === 'yt-offline') await scenarioYtOffline();
    else if (SCENARIO === 'yt-ended') await scenarioYtEnded();
    else if (SCENARIO === 'burst') await scenarioBurst();
    else if (SCENARIO === 'rhythm') await scenarioRhythm();
    else if (SCENARIO === 'staged') await scenarioStaged();
    else if (SCENARIO === 'trials') await scenarioTrials();
    else await scenarioDegraded();
    check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
    if (failures.length) {
      console.log(`\nE2E FAIL: ${failures.length} check(s) failed`);
      app.exit(1);
    } else {
      console.log('\nE2E PASS');
      app.exit(0);
    }
    return;
  }

  // The scripted transcript finishes just under 10s in.
  await wait(11000);

  const state = JSON.parse(await q(`JSON.stringify({
    msgs: document.querySelectorAll('.msg').length,
    chat: document.querySelectorAll('.msg[data-platform]').length,
    tw: document.querySelectorAll('.msg img.plat-img[alt="twitch"]').length,
    gg: document.querySelectorAll('.msg img.plat-img[alt="goodgame"]').length,
    yt: document.querySelectorAll('.msg img.plat-img[alt="youtube"]').length,
    ytEmotes: document.querySelectorAll('.msg img.emote[src*="/yt-emotes/"]').length,
    ytCustomEmotes: document.querySelectorAll('.msg img.emote[src*="/yt-emotes/_"]').length,
    ytBadgeArt: document.querySelectorAll('.msg img.badge-img[src*="/yt-badges/"]').length,
    ytChips: Array.from(document.querySelectorAll('.msg[data-platform="youtube"] .badge')).map(b => b.textContent),
    roleIcons: Array.from(document.querySelectorAll('.msg img.badge-img[src*="/assets/badge-"]')).map((i) => ({
      platform: i.closest('.msg').dataset.platform,
      file: i.getAttribute('src').split('/').pop(),
      title: i.title,
      painted: i.getClientRects().length === 1,
      decoded: i.naturalWidth > 0 && i.naturalHeight > 0,
      masked: getComputedStyle(i).webkitMaskImage !== 'none' || getComputedStyle(i).maskImage !== 'none',
      h: Math.round(i.getBoundingClientRect().height * 10) / 10,
    })),
    roleChips: document.querySelectorAll('.msg .badge.moderator, .msg .badge.broadcaster').length,
    platImgH: Math.round(document.querySelector('.msg img.plat-img').getBoundingClientRect().height * 10) / 10,
    twArtH: Math.round(document.querySelector('.msg img.badge-img[src*="/twitch-badges/"]').getBoundingClientRect().height * 10) / 10,
    ytNames: Array.from(document.querySelectorAll('.msg[data-platform="youtube"] .name')).map(n => n.textContent),
    badges: document.querySelectorAll('.msg img.badge-img').length,
    ggIcons: document.querySelectorAll('.msg img.badge-img[src*="/gg-icons/"], .msg img.badge-img[src*="/chat-svg-icons/"]').length,
    emotes: document.querySelectorAll('.msg img.emote').length,
    emoteNames: Array.from(new Set(Array.from(document.querySelectorAll('.msg img.emote')).map(i => i.alt))),
    emotePairs: Array.from(new Map(Array.from(document.querySelectorAll('.msg img.emote')).map(i => [i.alt, i.currentSrc || i.src])).entries()),
    nativeEmotes: document.querySelectorAll('.msg img.emote[src*="/emoticons/v2/"]').length,
    ggEmotes: document.querySelectorAll('.msg img.emote[src*="/gg-smiles/"]').length,
    ggBigEmotes: document.querySelectorAll('.msg img.emote[src*="-big.png"]').length,
    brokenImages: Array.from(document.querySelectorAll('.msg img')).filter(i => i.complete && i.naturalWidth === 0).length,
    urls: document.querySelectorAll('.msg .url').length,
    names: Array.from(document.querySelectorAll('.msg .name')).map(n => n.textContent),
    colors: Array.from(document.querySelectorAll('.msg .name')).map(n => n.style.color),
    status: document.getElementById('status').textContent,
    dots: Array.from(document.querySelectorAll('#status .src-dot')).map(d => d.className + ' ' + d.title),
    // A border would resize the bar; the separator must be a box-shadow.
    barBorder: getComputedStyle(document.getElementById('bar')).borderBottomWidth,
    updateHidden: document.getElementById('btn-update').getClientRects().length === 0
  })`));

  console.log('\nrendered:', JSON.stringify({
    msgs: state.msgs, tw: state.tw, gg: state.gg, yt: state.yt, badges: state.badges, ggIcons: state.ggIcons,
    ytEmotes: state.ytEmotes,
    emotes: state.emotes, distinctEmotes: state.emoteNames.length, native: state.nativeEmotes,
  }));

  if (process.env.OVERLAY_E2E_DUMP) {
    for (const [alt, src] of state.emotePairs) console.log(`  emote ${alt} -> ${src}`);
  }

  if (!ONLY) {
    check('all three platforms rendered', state.tw > 0 && state.gg > 0 && state.yt > 0,
      `tw=${state.tw} gg=${state.gg} yt=${state.yt}`);
    check('every scripted message arrived', state.msgs >= 37, `msgs=${state.msgs}`);
    check('twitch badge artwork rendered', state.badges >= 3, `badges=${state.badges}`);
    check('goodgame icons rendered', state.ggIcons >= 3, `ggIcons=${state.ggIcons}`);
    check('emotes rendered', state.emotes >= 2, `emotes=${state.emotes}`);
    // A demo that shows the same two emotes over and over is not a demo, and a
    // catalogue lookup that silently matched only one name would still pass a
    // bare count check.
    check('a spread of different emotes rendered', state.emoteNames.length >= 12,
      `distinct=${state.emoteNames.length} (${state.emoteNames.join(', ')})`);
    check("twitch's own emotes rendered from the emotes tag", state.nativeEmotes >= 5,
      `native=${state.nativeEmotes}`);
    // GoodGame's "small" is 18px and the overlay draws at ~27; the big variant
    // is the one that does not arrive blurred.
    check('goodgame smiles use the high-resolution variant',
      state.ggEmotes > 0 && state.ggEmotes === state.ggBigEmotes,
      `gg=${state.ggEmotes} big=${state.ggBigEmotes}`);
    // YouTube sends emote artwork on the message itself, so these arrive with
    // no catalogue fetched at all — which is the one way it is simpler than
    // either other platform, and worth proving rather than assuming.
    check('youtube emoji rendered straight off the message', state.ytEmotes >= 8,
      `ytEmotes=${state.ytEmotes}`);
    check('a channel membership emoji rendered too', state.ytCustomEmotes >= 1,
      `custom=${state.ytCustomEmotes}`);
    check('youtube membership badge artwork rendered', state.ytBadgeArt >= 1,
      `ytBadgeArt=${state.ytBadgeArt}`);
    // Neither YouTube nor GoodGame publishes artwork for a moderator or a
    // channel owner, so the app draws its own — the same two symbols Twitch
    // uses, so one glance reads the same on all three platforms.
    const roles = state.roleIcons;
    const at = (platform, file) => roles.filter((r) => r.platform === platform && r.file === file);
    check('a youtube moderator draws the sword, not the letters MOD',
      at('youtube', 'badge-moderator.svg').length >= 1, JSON.stringify(roles));
    check('a youtube channel owner draws the camera',
      at('youtube', 'badge-broadcaster.svg').length >= 1, JSON.stringify(roles));
    check('a goodgame moderator draws the same sword',
      at('goodgame', 'badge-moderator.svg').length >= 1, JSON.stringify(roles));
    check('a goodgame HOST draws the same camera',
      at('goodgame', 'badge-broadcaster.svg').length >= 1, JSON.stringify(roles));
    // Present in the DOM proves nothing: the mask bug this project already had
    // once left every badge visible and every badge the same shape. So: it is
    // painted, the file it names actually decoded to pixels, and nothing is
    // drawing it through a mask, which would throw the artwork away.
    check('every role icon is painted, decoded and unmasked',
      roles.length >= 4 && roles.every((r) => r.painted && r.decoded && !r.masked),
      JSON.stringify(roles));
    // The role each icon claims has to be the role it draws, or a colourblind
    // user and a screen reader are both told the wrong thing.
    check('each icon carries the tooltip for the role it draws',
      roles.every((r) => /mod/i.test(r.title) === (r.file === 'badge-moderator.svg')),
      JSON.stringify(roles.map((r) => r.file + ':' + r.title)));
    check('no role is left as a text chip', state.roleChips === 0,
      JSON.stringify(state.ytChips));
    // Layout: these reuse the .badge-img rule Twitch artwork already used, so
    // they must measure the same as it and as the platform logo beside them.
    // A badge taller than --badge-size would push every line it appears on.
    check('role icons measure exactly like the badges already on the line',
      roles.every((r) => r.h === state.twArtH) && state.twArtH === state.platImgH,
      `roles=${JSON.stringify(roles.map((r) => r.h))} twitch=${state.twArtH} plat=${state.platImgH}`);
    // The membership badge is the one YouTube does send artwork for, and it is
    // still that artwork rather than one of ours.
    check('youtube roles no longer need a text chip, its member badge is unaffected',
      state.ytChips.length === 0 && state.ytBadgeArt >= 1,
      JSON.stringify(state.ytChips));
    check('youtube nickname present', state.ytNames.includes('@northwind_ada'),
      JSON.stringify(state.ytNames));

    check('url highlighted', state.urls >= 1, `urls=${state.urls}`);
    check('goodgame nickname present', state.names.includes('КотБаюн'));
    check('twitch nickname present', state.names.includes('pixel_wraith'));
    check('exact twitch colour kept', state.colors.includes('rgb(0, 0, 255)'),
      'expected the raw #0000FF a user picked');
    check('every channel online', state.dots.length === 3 && state.dots.every((d) => /^src-dot online /.test(d)),
      JSON.stringify(state.dots));
    check('the dot names the channel it stands for',
      state.dots.some((d) => d.includes('tw/halcyon_tv'))
      && state.dots.some((d) => d.includes('gg/vetroduy'))
      && state.dots.some((d) => d.includes('yt/@northlight')),
      JSON.stringify(state.dots));

    // What each state is actually painted as, measured on a dot the app made
    // rather than read off a stylesheet. `offline` had no rule and fell through
    // to the same grey a channel that was never switched on is drawn in.
    //
    // It is driven here rather than waited for because the app holds `offline`
    // for a single tick: onclose reports it and scheduleRetry replaces it with
    // `connecting` in the same task, so it never survives to a repaint. That is
    // why the missing rule went unnoticed, and it is exactly why the colour has
    // to be pinned by a test instead of by having been seen.
    const colours = JSON.parse(await q(`(() => {
      const dot = document.querySelector('#status .src-dot');
      const was = dot.className;
      const out = {};
      for (const s of ['online', 'connecting', 'offline', 'error']) {
        dot.className = 'src-dot ' + s;
        out[s] = getComputedStyle(dot).backgroundColor;
      }
      // The bare class, which is what a dot with no state of its own gets.
      dot.className = 'src-dot';
      out.unconfigured = getComputedStyle(dot).backgroundColor;
      dot.className = was;
      return JSON.stringify(out);
    })()`));
    check('a connection that has gone is painted as trouble, not as grey',
      colours.offline === 'rgb(248, 81, 73)', JSON.stringify(colours));
    check('no state that means "not working" looks like one that was never switched on',
      ['connecting', 'offline', 'error'].every((s) => colours[s] !== colours.unconfigured),
      JSON.stringify(colours));
  } else {
    check(`${ONLY} messages rendered`, state.msgs >= 10, `msgs=${state.msgs}`);
  }
  check('no broken images', state.brokenImages === 0, `broken=${state.brokenImages}`);
  check('the bar separator is a shadow, not a border', state.barBorder === '0px', state.barBorder);
  check('update button hidden with no update', state.updateHidden);

  await snap('overlay.png');

  // Backdrop: transparent unless unlocked and hovered.
  const BG = `getComputedStyle(document.getElementById('chat')).backgroundColor`;
  // The per-channel row as a whole: querying one `.src-name` throws when the
  // channel list is empty, which is a legitimate configuration.
  const NAME_OPACITY = `getComputedStyle(document.querySelector('#status .src-list')).opacity`;
  // Everything the bar shows at rest, by whether it is painted at all. The
  // healthy answer is "nothing": the dots and names are the hover readout and
  // the alert is display:none until there is something to report.
  // Both axes matter: getClientRects alone counts an element its parent has
  // faded to nothing, and a computed opacity alone counts one that is
  // display:none. Neither is on screen.
  const STATUS_PAINTED = `JSON.stringify(Array.from(document.querySelectorAll('#status *'))
    .filter((el) => {
      if (el.getClientRects().length === 0) return false;
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (Number(getComputedStyle(n).opacity) === 0) return false;
      }
      return true;
    })
    .map((el) => el.className))`;
  const BAR_BG = `getComputedStyle(document.getElementById('bar')).backgroundColor`;
  const BAR_SHADOW = `getComputedStyle(document.getElementById('bar')).boxShadow`;
  // Every element in the bar, not just the three flex-filled containers: those
  // stretch to the bar whatever their children do, so measuring only them
  // reports "no change" while a dot moves 80px inside them.
  const BAR_LAYOUT = `JSON.stringify(Array.from(document.querySelectorAll('#bar, #bar *')).map((el) => {
    const r = el.getBoundingClientRect();
    return [el.id || String(el.className.baseVal ?? el.className) || el.tagName,
            Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  }))`;
  const placed = (ok, where) =>
    check(`the harness put the window ${where} the pointer`, ok,
      `cursor=${JSON.stringify(screen.getCursorScreenPoint())} window=${JSON.stringify(win.getBounds())}`);

  placed(await placeWindowVerified('away'), 'away from');
  check('unlocked, not hovered: no backdrop', await until(`${BG} === 'rgba(10, 12, 18, 0)'`),
    await q(BG));
  check('not hovered: channel names are invisible', await until(`${NAME_OPACITY} === '0'`));
  // With every channel connected the bar says nothing at all. A green light
  // that is on in every session carries no information the arriving messages
  // do not already carry, and it costs pixels over a game to say "as
  // expected" — so the healthy state is drawn as silence, and the appearance
  // of anything is itself the signal.
  check('healthy and not hovered: the bar shows no status at all',
    await until(`${STATUS_PAINTED} === '[]'`), await q(STATUS_PAINTED));
  // At rest the bar is not there at all: no strip, no seam, just the chat.
  check('not hovered: the bar is invisible',
    await until(`${BAR_BG} === 'rgba(0, 0, 0, 0)' && ${BAR_SHADOW} === 'none'`),
    `${await q(BAR_BG)} / ${await q(BAR_SHADOW)}`);
  const layoutCold = await q(BAR_LAYOUT);
  placed(await placeWindowVerified('under'), 'under');
  check('unlocked, hovered: backdrop visible', await until(`${BG} === 'rgba(10, 12, 18, 0.55)'`),
    await q(BG));
  // The same hover that fades the backdrop in also names each dot's channel.
  check('hovering reveals the channel names', await until(`${NAME_OPACITY} === '1'`));
  // Each dot sits with the name it stands for, rather than in a row of
  // anonymous dots with the names somewhere to their right.
  check('each dot is paired with its own channel name',
    await q(`JSON.stringify(Array.from(document.querySelectorAll('#status .src-pair')).map(
      (p) => [!!p.querySelector('.src-dot'), p.querySelector('.src-name').textContent]))`)
      === JSON.stringify([[true, 'tw/halcyon_tv'], [true, 'gg/vetroduy'], [true, 'yt/@northlight']]),
    await q(`JSON.stringify(Array.from(document.querySelectorAll('#status .src-pair')).map((p) => p.textContent))`));
  // The bar is a drag region. If hovering resizes anything in it, Chromium
  // recomputes that region, which disturbs the pointer, which drops the hover,
  // which resizes it back — a flicker loop several times a second that makes
  // the bar unusable. Hover may repaint; it may not reflow.
  check('hovering does not change the bar layout', (await q(BAR_LAYOUT)) === layoutCold,
    `cold=${layoutCold} hot=${await q(BAR_LAYOUT)}`);
  // What the bar is for: something solid to aim at and drag the window by.
  check('hovering raises the strip to drag by',
    await until(`${BAR_BG} !== 'rgba(0, 0, 0, 0)' && ${BAR_SHADOW}.includes('inset')`),
    `${await q(BAR_BG)} / ${await q(BAR_SHADOW)}`);
  check('hovering shows where to grab the window',
    await until(`getComputedStyle(document.getElementById('drag-handle')).opacity > 0.5`));
  await snap('overlay-hover.png');

  // The whole bar must stay draggable. Marking the status dots as no-drag once
  // stole that surface, and because the names expand on hover it went missing
  // exactly as the pointer arrived to grab the window.
  const optedOut = JSON.parse(await q(`JSON.stringify(
    Array.from(document.querySelectorAll('#grip, #grip *, #bar > :not(button)'))
      .filter((el) => getComputedStyle(el).webkitAppRegion === 'no-drag')
      .map((el) => el.id || el.className || el.tagName)
  )`));
  check('nothing inside the grip opts out of dragging', optedOut.length === 0, JSON.stringify(optedOut));
  check('the whole bar is a drag region, empty space included',
    await q(`['bar', 'grip'].every((id) => getComputedStyle(document.getElementById(id)).webkitAppRegion === 'drag')`));
  // Unlocked, the feed moves the window too, so there is no hunting for a
  // strip to grab. The scrollbar and the resize corner opt back out.
  check('the chat area moves the window while unlocked',
    await q(`getComputedStyle(document.getElementById('chat')).webkitAppRegion === 'drag'`));
  check('the scrollbar and resize corner stay out of it',
    await q(`['scroll-guard', 'resize'].every((id) => getComputedStyle(document.getElementById(id)).webkitAppRegion === 'no-drag')`));

  // A link is the one thing in the feed there is anything to do with. Someone
  // posts a clip and there has to be a way to reach it that is not retyping it
  // off the screen.
  const link = JSON.parse(await q(`JSON.stringify((() => {
    const el = document.querySelector('.msg .url');
    const text = document.querySelector('.msg .text');
    return {
      painted: !!el && el.getClientRects().length > 0,
      href: el ? el.textContent : '',
      region: el ? getComputedStyle(el).webkitAppRegion : '',
      textRegion: text ? getComputedStyle(text).webkitAppRegion : '',
      cursor: el ? getComputedStyle(el).cursor : '',
      select: el ? getComputedStyle(el).userSelect : ''
    };
  })())`));
  check('a link is painted in the feed', link.painted);
  // Drawing on top of a drag region does not mask it, so without a no-drag of
  // its own the click would be read as the start of a window drag.
  check('links opt out of the feed drag region', link.region === 'no-drag', link.region);
  // And only the link does: dragging the window by the chat is a feature.
  check('ordinary message text stays drag surface', link.textRegion !== 'no-drag', link.textRegion);
  check('a link looks clickable', link.cursor === 'pointer', link.cursor);
  // Selection is off globally; a link has to opt back in or it cannot even be
  // copied.
  check('a link can be selected and copied', link.select === 'text', link.select);
  await q(`document.querySelector('.msg .url').click(); true`);
  check('clicking a link hands it to the browser',
    (await untilLocal(() => openedLinks.length > 0)) && openedLinks.length === 1 && openedLinks[0] === link.href,
    `${JSON.stringify(openedLinks)} vs ${link.href}`);

  // Settings panel opens, closes, and swaps the cog for a back arrow.
  await q(`document.getElementById('btn-settings').click(); true`);
  const opened = await until(`document.getElementById('settings').getClientRects().length > 0`);
  const settings = JSON.parse(await q(`JSON.stringify({
    painted: ${opened},
    back: getComputedStyle(document.querySelector('#btn-settings .i-back')).display,
    rows: document.querySelectorAll('#sources .src-row').length,
    overflowX: document.querySelector('.settings-body').scrollWidth - document.querySelector('.settings-body').clientWidth,
    groups: document.querySelectorAll('#settings .group').length,
    open: Array.from(document.querySelectorAll('#settings .group')).filter((g) => g.open).map((g) => g.id),
    exits: document.querySelectorAll('#settings button[id*="close"], .settings-head').length,
    // The bar floats above the panel, so both the content and the scroll track
    // must start below it — a scrollbar running up behind the bar's buttons is
    // what prompted this.
    clearsBar: document.querySelector('#settings .group').getBoundingClientRect().top
      >= document.getElementById('bar').getBoundingClientRect().bottom,
    scrollerClearsBar: document.querySelector('.settings-body').getBoundingClientRect().top
      >= document.getElementById('bar').getBoundingClientRect().bottom,
    // Hit targets in the bar, which were too small to aim at comfortably.
    iconSize: Math.round(document.getElementById('btn-settings').getBoundingClientRect().height),
    // Drawing on top of the draggable chat does not mask its drag rect, so the
    // panel has to opt out or none of its controls can be clicked.
    panelRegion: getComputedStyle(document.getElementById('settings')).webkitAppRegion,
    controlRegions: ['btn-add-source', 'fontSize', 'customCss'].map(
      (id) => getComputedStyle(document.getElementById(id)).webkitAppRegion)
  })`));
  check('settings panel opens', settings.painted);
  check('settings lists the configured channels', settings.rows === (ONLY ? 1 : 3), `rows=${settings.rows}`);
  check('settings icon swaps to back arrow', settings.back === 'block');
  check('settings does not overflow sideways', settings.overflowX === 0, `overflow=${settings.overflowX}`);
  check('settings is split into collapsible groups', settings.groups >= 8, `groups=${settings.groups}`);
  check('only Channels is expanded to begin with',
    JSON.stringify(settings.open) === '["g-channels"]', JSON.stringify(settings.open));
  // Two ways out, overlapping each other in the same corner, is what prompted
  // this: the panel's own header sat underneath the bar's back arrow.
  check('the bar back arrow is the only way out', settings.exits === 0, `exits=${settings.exits}`);
  check('settings content clears the floating bar', settings.clearsBar);
  check('the settings scroll track clears the bar', settings.scrollerClearsBar);
  check('bar buttons are a comfortable hit target', settings.iconSize >= 28, `size=${settings.iconSize}`);
  check('settings is not swallowed by the draggable chat beneath it',
    settings.panelRegion === 'no-drag', settings.panelRegion);
  check('settings controls are clickable, not drag surface',
    settings.controlRegions.every((r) => r !== 'drag'), JSON.stringify(settings.controlRegions));
  await snap('settings.png');

  // Expanding a group reveals its controls.
  await q(`document.getElementById('g-text').open = true; true`);
  check('expanding a group reveals its controls',
    await until(`document.getElementById('fontSize').getClientRects().length > 0`));

  // "Overall opacity" is the chat's, not the window's. Set on <body> it faded
  // the settings panel and the bar with it, so dragging the slider to its 0.2
  // floor over a bright game left the control needed to drag it back at 20%
  // over that same game.
  const setOpacity = (v) => q(`(() => {
    const slider = document.getElementById('opacity');
    slider.value = '${v}';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await setOpacity('0.2');
  const faded = JSON.parse(await q(`JSON.stringify((() => {
    // What reaches the screen is the product down the whole ancestor chain,
    // wherever the opacity happens to be set.
    const effective = (el) => {
      let o = 1;
      for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      return o;
    };
    return {
      chat: effective(document.getElementById('chat')),
      settings: effective(document.getElementById('settings')),
      slider: effective(document.getElementById('opacity')),
      bar: effective(document.getElementById('bar')),
      painted: document.getElementById('opacity').getClientRects().length > 0,
      // Opacity makes a stacking context, so ask what is actually at the pixel
      // rather than trusting the panel is still drawn over the faded feed.
      onTop: (() => {
        const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
        return !!el && document.getElementById('settings').contains(el);
      })()
    };
  })())`));
  check('the feed fades with the opacity setting', Math.abs(faded.chat - 0.2) < 0.001, faded.chat);
  check('the settings panel stays opaque at the opacity floor', faded.settings === 1, faded.settings);
  check('so does the slider that undoes it', faded.slider === 1 && faded.painted, faded.slider);
  check('and so does the bar', faded.bar === 1, faded.bar);
  check('the panel is still what is drawn over the faded feed', faded.onTop);
  await setOpacity('1');

  // The lock button's tooltip names the hotkey that brings the overlay back —
  // the one thing a user checks when they cannot. A tooltip is an attribute by
  // nature; there is nothing painted to measure.
  const rebind = (accel) => q(`(() => {
    const input = document.getElementById('hotkeyLock');
    input.value = '${accel}';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return document.getElementById('btn-lock').title;
  })()`);
  check('the lock tooltip names the configured hotkey',
    (await q(`document.getElementById('btn-lock').title`)).includes('Control+Alt+O'),
    await q(`document.getElementById('btn-lock').title`));
  const rebound = await rebind('Control+Alt+K');
  check('and follows the hotkey when it is rebound',
    rebound.includes('Control+Alt+K') && !rebound.includes('Control+Alt+O'), rebound);
  await rebind('Control+Alt+O');

  await q(`document.getElementById('g-text').open = false; true`);

  await q(`document.getElementById('btn-settings').click(); true`);
  check('settings panel closes',
    await until(`document.getElementById('settings').getClientRects().length === 0`));

  /*
   * The update button in the state every user eventually reaches. Its icon is a
   * child of the button, so writing the button's own textContent replaced it —
   * and the run only ever asserted the button was hidden when there was no
   * update, which is how it shipped as bare text.
   */
  const UPDATE_BUTTON = `JSON.stringify((() => {
    const icon = document.querySelector('#btn-update svg');
    const label = document.getElementById('update-label');
    return {
      button: document.getElementById('btn-update').getClientRects().length > 0,
      icon: !!icon && icon.getClientRects().length > 0,
      labelPainted: !!label && label.getClientRects().length > 0,
      label: label ? label.textContent : null,
      status: document.getElementById('update-status').textContent
    };
  })())`;
  win.webContents.send('update:available', { version: '99.0.0', current: app.getVersion() });
  check('an offered update raises the button',
    await until(`document.getElementById('btn-update').getClientRects().length > 0`));
  const offered = JSON.parse(await q(UPDATE_BUTTON));
  check('the download icon is still painted alongside the offer', offered.icon, JSON.stringify(offered));
  check('and the label says which version',
    offered.labelPainted && offered.label === 'Update to 99.0.0', JSON.stringify(offered.label));

  // Clicking it starts the download. Nothing is pending in the main process, so
  // it fails at once — which is the path that writes the label twice more.
  await q(`document.getElementById('btn-update').click(); true`);
  check('a failed update says so',
    await until(`/Update failed/.test(document.getElementById('update-status').textContent)`),
    await q(`document.getElementById('update-status').textContent`));
  const afterClick = JSON.parse(await q(UPDATE_BUTTON));
  check('the icon survives downloading and failing', afterClick.button && afterClick.icon,
    JSON.stringify(afterClick));
  check('and the label goes back to the offer', afterClick.label === 'Update to 99.0.0',
    JSON.stringify(afterClick.label));

  win.webContents.send('update:none', { current: app.getVersion() });
  check('withdrawing the offer hides the button again',
    await until(`document.getElementById('btn-update').getClientRects().length === 0`));
  // The click opened settings on its way past.
  await q(`document.getElementById('btn-settings').click(); true`);
  check('settings closes again',
    await until(`document.getElementById('settings').getClientRects().length === 0`));

  // Locked: no chrome, no backdrop, still showing messages.
  await q(`window.overlay.setLocked(true)`);
  await wait(600);
  const locked = JSON.parse(await q(`JSON.stringify({
    bar: document.getElementById('bar').getClientRects().length > 0,
    bg: getComputedStyle(document.getElementById('chat')).backgroundColor,
    msgs: document.querySelectorAll('.msg').length
  })`));
  check('locked hides the bar', !locked.bar);
  check('locked has no backdrop', locked.bg === 'rgba(10, 12, 18, 0)', locked.bg);
  check('locked still shows messages', locked.msgs > 0);
  // Locked, every click belongs to the game underneath — which is the whole
  // point of the app. The window is click-through, so a real click never gets
  // here at all; this drives the element directly to prove the app does not
  // open links behind a game either.
  const openedBeforeLock = openedLinks.length;
  await q(`document.querySelector('.msg .url').click(); true`);
  await wait(300);
  check('locked, a link does not open — the click is the game\'s',
    openedLinks.length === openedBeforeLock, JSON.stringify(openedLinks));
  await snap('overlay-locked.png');

  if (MEDIA) {
    // Frames for the animation, captured from the locked overlay so the demo
    // shows the state people actually use.
    for (let i = 0; i < 40; i++) {
      await snap(`frame-${String(i).padStart(3, '0')}.png`);
      await wait(500);
    }
  }

  check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

  if (failures.length) {
    console.log(`\nE2E FAIL: ${failures.length} check(s) failed`);
    app.exit(1);
  } else {
    console.log('\nE2E PASS');
    app.exit(0);
  }
});

// Anything the scenario throws must end the run, not leave it hanging.
process.on('unhandledRejection', (err) => {
  console.log('\nE2E FAIL: ' + (err && err.stack ? err.stack : err));
  app.exit(1);
});
