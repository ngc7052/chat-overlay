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
app.setPath('userData', PROFILE);

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
function placeWindow(where) {
  const pt = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(pt).workArea;
  const [w, h] = win.getSize();
  if (where === 'under') {
    win.setPosition(Math.round(pt.x - w / 2), Math.round(pt.y - h / 2));
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
const snap = async (name) => {
  if (!MEDIA) return;
  fs.mkdirSync(MEDIA, { recursive: true });
  fs.writeFileSync(path.join(MEDIA, PREFIX + name), (await win.capturePage()).toPNG());
};

app.whenReady().then(async () => {
  await wait(1500);
  if (!win) { console.log('E2E FAIL: no window'); app.exit(1); return; }

  // The scripted transcript finishes just under 10s in.
  await wait(11000);

  const state = JSON.parse(await q(`JSON.stringify({
    msgs: document.querySelectorAll('.msg').length,
    chat: document.querySelectorAll('.msg[data-platform]').length,
    tw: document.querySelectorAll('.msg img.plat-img[alt="twitch"]').length,
    gg: document.querySelectorAll('.msg img.plat-img[alt="goodgame"]').length,
    badges: document.querySelectorAll('.msg img.badge-img').length,
    ggIcons: document.querySelectorAll('.msg img.badge-img[src*="/gg-icons/"], .msg img.badge-img[src*="/chat-svg-icons/"]').length,
    emotes: document.querySelectorAll('.msg img.emote').length,
    emoteNames: Array.from(new Set(Array.from(document.querySelectorAll('.msg img.emote')).map(i => i.alt))),
    emotePairs: Array.from(new Map(Array.from(document.querySelectorAll('.msg img.emote')).map(i => [i.alt, i.currentSrc || i.src])).entries()),
    nativeEmotes: document.querySelectorAll('.msg img.emote[src*="/emoticons/v2/"]').length,
    brokenImages: Array.from(document.querySelectorAll('.msg img')).filter(i => i.complete && i.naturalWidth === 0).length,
    urls: document.querySelectorAll('.msg .url').length,
    names: Array.from(document.querySelectorAll('.msg .name')).map(n => n.textContent),
    colors: Array.from(document.querySelectorAll('.msg .name')).map(n => n.style.color),
    status: document.getElementById('status').textContent,
    dots: Array.from(document.querySelectorAll('#status .src-dot')).map(d => d.className + ' ' + d.title),
    // The bar is a control surface, not a titlebar: no fill, no bottom rule.
    barBg: getComputedStyle(document.getElementById('bar')).backgroundColor,
    barBorder: getComputedStyle(document.getElementById('bar')).borderBottomWidth,
    updateHidden: document.getElementById('btn-update').getClientRects().length === 0
  })`));

  console.log('\nrendered:', JSON.stringify({
    msgs: state.msgs, tw: state.tw, gg: state.gg, badges: state.badges, ggIcons: state.ggIcons,
    emotes: state.emotes, distinctEmotes: state.emoteNames.length, native: state.nativeEmotes,
  }));

  if (process.env.OVERLAY_E2E_DUMP) {
    for (const [alt, src] of state.emotePairs) console.log(`  emote ${alt} -> ${src}`);
  }

  if (!ONLY) {
    check('both platforms rendered', state.tw > 0 && state.gg > 0, `tw=${state.tw} gg=${state.gg}`);
    check('every scripted message arrived', state.msgs >= 25, `msgs=${state.msgs}`);
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
    check('url highlighted', state.urls >= 1, `urls=${state.urls}`);
    check('goodgame nickname present', state.names.includes('КотБаюн'));
    check('twitch nickname present', state.names.includes('pixel_wraith'));
    check('exact twitch colour kept', state.colors.includes('rgb(0, 0, 255)'),
      'expected the raw #0000FF a user picked');
    check('both channels online', state.dots.length === 2 && state.dots.every((d) => /^src-dot online /.test(d)),
      JSON.stringify(state.dots));
    check('the dot names the channel it stands for',
      state.dots.some((d) => d.includes('tw/halcyon_tv')) && state.dots.some((d) => d.includes('gg/vetroduy')),
      JSON.stringify(state.dots));
  } else {
    check(`${ONLY} messages rendered`, state.msgs >= 10, `msgs=${state.msgs}`);
  }
  check('no broken images', state.brokenImages === 0, `broken=${state.brokenImages}`);
  // The seam this replaced was a solid strip with a 1px rule, which read as a
  // window titlebar bolted onto a transparent overlay.
  check('the bar has no fill of its own', state.barBg === 'rgba(0, 0, 0, 0)', state.barBg);
  check('the bar has no bottom rule', state.barBorder === '0px', state.barBorder);
  check('update button hidden with no update', state.updateHidden);

  await snap('overlay.png');

  // Backdrop: transparent unless unlocked and hovered.
  const BG = `getComputedStyle(document.getElementById('chat')).backgroundColor`;
  const NAME_OPACITY = `getComputedStyle(document.querySelector('#status .src-name')).opacity`;
  const BAR_LAYOUT = `JSON.stringify(['bar', 'grip', 'status'].map((id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height)];
  }))`;
  placeWindow('away');
  check('unlocked, not hovered: no backdrop', await until(`${BG} === 'rgba(10, 12, 18, 0)'`),
    await q(BG));
  check('not hovered: channel names are invisible', await until(`${NAME_OPACITY} === '0'`));
  const layoutCold = await q(BAR_LAYOUT);
  placeWindow('under');
  check('unlocked, hovered: backdrop visible', await until(`${BG} === 'rgba(10, 12, 18, 0.55)'`),
    await q(BG));
  // The same hover that fades the backdrop in also names each dot's channel.
  check('hovering reveals the channel names', await until(`${NAME_OPACITY} === '1'`));
  // The bar is a drag region. If hovering resizes anything in it, Chromium
  // recomputes that region, which disturbs the pointer, which drops the hover,
  // which resizes it back — a flicker loop several times a second that makes
  // the bar unusable. Hover may repaint; it may not reflow.
  check('hovering does not change the bar layout', (await q(BAR_LAYOUT)) === layoutCold,
    `cold=${layoutCold} hot=${await q(BAR_LAYOUT)}`);
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
    // The bar floats above the panel; its content must start below it.
    clearsBar: document.querySelector('#settings .group').getBoundingClientRect().top
      >= document.getElementById('bar').getBoundingClientRect().bottom
  })`));
  check('settings panel opens', settings.painted);
  check('settings lists the configured channels', settings.rows === (ONLY ? 1 : 2), `rows=${settings.rows}`);
  check('settings icon swaps to back arrow', settings.back === 'block');
  check('settings does not overflow sideways', settings.overflowX === 0, `overflow=${settings.overflowX}`);
  check('settings is split into collapsible groups', settings.groups >= 8, `groups=${settings.groups}`);
  check('only Channels is expanded to begin with',
    JSON.stringify(settings.open) === '["g-channels"]', JSON.stringify(settings.open));
  // Two ways out, overlapping each other in the same corner, is what prompted
  // this: the panel's own header sat underneath the bar's back arrow.
  check('the bar back arrow is the only way out', settings.exits === 0, `exits=${settings.exits}`);
  check('settings content clears the floating bar', settings.clearsBar);
  await snap('settings.png');

  // Expanding a group reveals its controls.
  await q(`document.getElementById('g-text').open = true; true`);
  check('expanding a group reveals its controls',
    await until(`document.getElementById('fontSize').getClientRects().length > 0`));
  await q(`document.getElementById('g-text').open = false; true`);

  await q(`document.getElementById('btn-settings').click(); true`);
  check('settings panel closes',
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
