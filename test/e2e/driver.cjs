/**
 * Runs inside Electron. Boots the real app, waits for the scripted transcript to
 * arrive over the fake sockets, then asserts on the rendered DOM.
 *
 * Assertions are about what is painted (getClientRects) rather than what an
 * attribute claims — an earlier bug in this project passed an attribute check
 * while the element was plainly visible on screen.
 */
const { app, BrowserWindow } = require('electron');
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
    ggIcons: document.querySelectorAll('.msg img.badge-img[src*="gg-icons"]').length,
    emotes: document.querySelectorAll('.msg img.emote').length,
    brokenImages: Array.from(document.querySelectorAll('.msg img')).filter(i => i.complete && i.naturalWidth === 0).length,
    urls: document.querySelectorAll('.msg .url').length,
    names: Array.from(document.querySelectorAll('.msg .name')).map(n => n.textContent),
    colors: Array.from(document.querySelectorAll('.msg .name')).map(n => n.style.color),
    status: document.getElementById('status').textContent,
    updateHidden: document.getElementById('btn-update').getClientRects().length === 0
  })`));

  console.log('\nrendered:', JSON.stringify({
    msgs: state.msgs, tw: state.tw, gg: state.gg, badges: state.badges, ggIcons: state.ggIcons, emotes: state.emotes,
  }));

  if (!ONLY) {
    check('both platforms rendered', state.tw > 0 && state.gg > 0, `tw=${state.tw} gg=${state.gg}`);
    check('every scripted message arrived', state.msgs >= 25, `msgs=${state.msgs}`);
    check('twitch badge artwork rendered', state.badges >= 3, `badges=${state.badges}`);
    check('goodgame icons rendered', state.ggIcons >= 3, `ggIcons=${state.ggIcons}`);
    check('emotes rendered', state.emotes >= 2, `emotes=${state.emotes}`);
    check('url highlighted', state.urls >= 1, `urls=${state.urls}`);
    check('goodgame nickname present', state.names.includes('КотБаюн'));
    check('twitch nickname present', state.names.includes('pixel_wraith'));
    check('exact twitch colour kept', state.colors.includes('rgb(0, 0, 255)'),
      'expected the raw #0000FF a user picked');
    check('both channels online', /● tw\/halcyon_tv/.test(state.status) && /● gg\/vetroduy/.test(state.status), state.status);
  } else {
    check(`${ONLY} messages rendered`, state.msgs >= 10, `msgs=${state.msgs}`);
  }
  check('no broken images', state.brokenImages === 0, `broken=${state.brokenImages}`);
  check('update button hidden with no update', state.updateHidden);

  await snap('overlay.png');

  // Backdrop: transparent unless unlocked and hovered.
  const bgOf = () => q(`getComputedStyle(document.getElementById('chat')).backgroundColor`);
  win.webContents.sendInputEvent({ type: 'mouseLeave', x: -10, y: -10 });
  await wait(250);
  check('unlocked, not hovered: no backdrop', (await bgOf()) === 'rgba(10, 12, 18, 0)');
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 280, y: 300 });
  await wait(250);
  check('unlocked, hovered: backdrop visible', (await bgOf()) === 'rgba(10, 12, 18, 0.55)');
  await snap('overlay-hover.png');

  // Settings panel opens, closes, and swaps the cog for a back arrow.
  await q(`document.getElementById('btn-settings').click(); true`);
  await wait(300);
  const settings = JSON.parse(await q(`JSON.stringify({
    painted: document.getElementById('settings').getClientRects().length > 0,
    back: getComputedStyle(document.querySelector('#btn-settings .i-back')).display,
    rows: document.querySelectorAll('#sources .src-row').length,
    overflowX: document.querySelector('.settings-body').scrollWidth - document.querySelector('.settings-body').clientWidth
  })`));
  check('settings panel opens', settings.painted);
  check('settings lists the configured channels', settings.rows === (ONLY ? 1 : 2), `rows=${settings.rows}`);
  check('settings icon swaps to back arrow', settings.back === 'block');
  check('settings does not overflow sideways', settings.overflowX === 0, `overflow=${settings.overflowX}`);
  await snap('settings.png');

  await q(`document.getElementById('btn-settings-close').click(); true`);
  await wait(250);
  check('settings panel closes', await q(`document.getElementById('settings').getClientRects().length === 0`));

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
