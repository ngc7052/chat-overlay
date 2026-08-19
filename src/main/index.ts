import {
  app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, net, screen, shell, Tray,
} from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { activeSources, defaultConfig, parseConfig } from './config.js';
import { resolveEndpoints, rewriteApiUrl } from './endpoints.js';
import type { Config, PayloadHandoff, ReleaseInfo } from './types.js';
import { watchPointer } from './pointer.js';
import { createUpdater } from './updater/index.js';

/** Window, tray, hotkeys and IPC. The decisions live in the modules it calls. */

const RELEASE_API = process.env['OVERLAY_UPDATE_API'] ??
  'https://api.github.com/repos/ngc7052/chat-overlay/releases/latest';
const RELEASES_PAGE = 'https://github.com/ngc7052/chat-overlay/releases/latest';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 8000;

const handoff = (globalThis as { __overlayPayload?: PayloadHandoff }).__overlayPayload;

const configFile = () => path.join(app.getPath('userData'), 'config.json');

let config: Config = defaultConfig();
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const updater = createUpdater({
  fetch: (url, init) => net.fetch(url, init as RequestInit) as unknown as ReturnType<typeof fetch>,
  releaseApi: RELEASE_API,
  incomingDir: () => handoff?.incomingDir ?? path.join(app.getPath('userData'), 'payload-new'),
  currentVersion: () => handoff?.version ?? app.getVersion(),
  quarantinedVersion: () => handoff?.quarantinedVersion() ?? null,
});

/* ------------------------------------------------------------------ config */

function loadConfig(): void {
  let text: string | null = null;
  try {
    text = fs.readFileSync(configFile(), 'utf8');
  } catch {
    text = null;
  }
  config = parseConfig(text);
}

function saveConfig(): void {
  // Cancel a pending debounced write: this call supersedes it, and on the
  // will-quit path there may be no event loop left for the timer to fire on.
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('config save failed:', (err as Error).message);
  }
}

function saveConfigDebounced(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveConfig, 400);
}

/* -------------------------------------------------------------------- icon */

function loadIcon(name: string) {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', name));
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

/* ------------------------------------------------------------------ window */

function clampToDisplay(bounds: Config['bounds']): Config['bounds'] {
  const b = { ...bounds };
  if (b.x == null || b.y == null) return b;
  const area = screen.getDisplayMatching({ x: b.x, y: b.y, width: b.width, height: b.height }).workArea;
  // Keep at least a 120x40 grab strip on screen.
  b.x = Math.min(Math.max(b.x, area.x - b.width + 120), area.x + area.width - 120);
  b.y = Math.min(Math.max(b.y, area.y), area.y + area.height - 40);
  return b;
}

function applyLock(): void {
  if (!win) return;
  // forward:true keeps mouse-move events flowing so hover styling still works.
  win.setIgnoreMouseEvents(config.locked, { forward: true });
  win.setFocusable(!config.locked);
  if (!config.locked) {
    win.showInactive();
    win.focus();
  }
  win.webContents.send('state:locked', config.locked);
  updateTrayMenu();
}

function applyHidden(): void {
  if (!win) return;
  if (config.hidden) win.hide();
  else win.showInactive();
  updateTrayMenu();
}

function createWindow(): void {
  const b = clampToDisplay(config.bounds);

  win = new BrowserWindow({
    width: b.width || 420,
    height: b.height || 620,
    ...(b.x == null ? {} : { x: b.x }),
    ...(b.y == null ? {} : { y: b.y }),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    show: false,
    minWidth: 220,
    minHeight: 120,
    icon: loadIcon('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    if (!config.hidden) win?.showInactive();
    applyLock();
    announceUpdate(false);   // a check may already have finished before this point
  });

  const persistBounds = () => {
    if (!win || win.isDestroyed()) return;
    const cur = win.getBounds();
    config.bounds = { x: cur.x, y: cur.y, width: cur.width, height: cur.height };
    saveConfigDebounced();
  };
  win.on('moved', persistBounds);
  win.on('resized', persistBounds);

  // Whether the pointer is over the window, tracked here rather than with CSS
  // :hover in the page. A drag region is handled as window chrome, so the page
  // never sees the mouse over the parts of it that move the window — which is
  // most of them.
  const pointerWatch = watchPointer({
    bounds: () => (win && !win.isDestroyed() ? win.getBounds() : null),
    cursor: () => screen.getCursorScreenPoint(),
    onChange: (over) => sendToWindow('state:pointerOver', over),
  });

  win.on('closed', () => { pointerWatch.stop(); win = null; });

  // Never navigate away; open any external link in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

/* -------------------------------------------------------------------- tray */

function updateTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: config.locked ? 'Unlock (edit / move)' : 'Lock (click-through)',
      accelerator: config.hotkeyLock,
      click: () => { config.locked = !config.locked; saveConfig(); applyLock(); },
    },
    {
      label: config.hidden ? 'Show overlay' : 'Hide overlay',
      accelerator: config.hotkeyHide,
      click: () => { config.hidden = !config.hidden; saveConfig(); applyHidden(); },
    },
    { type: 'separator' },
    { label: 'Reconnect all sources', click: () => win?.webContents.send('action:reconnect') },
    { label: 'Open config folder', click: () => void shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.setToolTip(
    'ChatOverlay — ' + (config.locked ? 'locked (click-through)' : 'unlocked') +
    '\n' + config.hotkeyLock + ' toggles',
  );
}

function createTray(): void {
  let img = loadIcon('tray.png');
  if (img.isEmpty()) img = loadIcon('icon.png');
  tray = new Tray(img);
  updateTrayMenu();
  tray.on('click', () => { config.locked = !config.locked; saveConfig(); applyLock(); });
}

/* --------------------------------------------------------------- shortcuts */

function registerShortcuts(): void {
  globalShortcut.unregisterAll();
  const reg = (accel: string, fn: () => void): boolean => {
    if (!accel) return true;
    try {
      return globalShortcut.register(accel, fn);
    } catch {
      return false;
    }
  };
  const okLock = reg(config.hotkeyLock, () => {
    config.locked = !config.locked; saveConfig(); applyLock();
  });
  const okHide = reg(config.hotkeyHide, () => {
    config.hidden = !config.hidden; saveConfig(); applyHidden();
  });
  if (win && !win.isDestroyed()) {
    win.webContents.send('state:hotkeys', { lock: okLock, hide: okHide });
  }
}

/* ----------------------------------------------------------------- updates */

let pendingUpdate: ReleaseInfo | null = null;
let stagedVersion: string | null = null;
let checkTimer: ReturnType<typeof setTimeout> | null = null;
let checkInterval: ReturnType<typeof setInterval> | null = null;

function sendToWindow(channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * A version boot quarantined is only surfaced when the user asked (manual
 * check) — never as a nag — and then only as a retry inside Settings.
 */
function announceUpdate(manual: boolean): void {
  if (!pendingUpdate) return;
  if (pendingUpdate.quarantined && !manual) return;
  sendToWindow('update:available', {
    ...pendingUpdate,
    staged: pendingUpdate.version === stagedVersion,
  });
}

async function checkForUpdates(manual: boolean): Promise<ReleaseInfo | { error: string }> {
  try {
    const result = await updater.check();
    const had = pendingUpdate;
    pendingUpdate = result.newer ? result : null;
    if (pendingUpdate) {
      announceUpdate(manual);
    } else if (manual || had) {
      // Either the user asked, or something announced earlier is no longer on
      // offer (release pulled) — the renderer must drop its button too.
      sendToWindow('update:none', result);
    }
    return result;
  } catch (err) {
    const message = (err as Error).message;
    if (manual) sendToWindow('update:error', message);
    console.warn('update check failed:', message);
    return { error: message };
  }
}

/** (Re)arm the background checks from config; safe to call at any time. */
function applyAutoCheck(): void {
  if (checkTimer) clearTimeout(checkTimer);
  if (checkInterval) clearInterval(checkInterval);
  checkTimer = null;
  checkInterval = null;
  if (!config.autoCheckUpdates) return;
  // Give the chat connections the first few seconds to themselves.
  checkTimer = setTimeout(() => void checkForUpdates(false), FIRST_CHECK_DELAY_MS);
  checkInterval = setInterval(() => void checkForUpdates(false), CHECK_INTERVAL_MS);
}

/* --------------------------------------------------------------------- IPC */

ipcMain.handle('config:get', () => config);

ipcMain.handle('config:set', (_e, patch: Partial<Config>) => {
  const prevLock = config.locked;
  const prevHotkeys = config.hotkeyLock + '|' + config.hotkeyHide;
  const prevAutoCheck = config.autoCheckUpdates;
  config = { ...config, ...patch };
  // The renderer persists on every `input` event, so a slider drag or a typed
  // channel name arrives here dozens of times a second — and the write is a
  // blocking one on the main thread. Coalesce them. The lock state is not a
  // preference, though: a crash must not leave the overlay unlocked on disk
  // while it is locked on screen, so that one goes straight out.
  if (config.locked !== prevLock) {
    saveConfig();
    applyLock();
  } else {
    saveConfigDebounced();
  }
  if (config.hotkeyLock + '|' + config.hotkeyHide !== prevHotkeys) registerShortcuts();
  if (config.autoCheckUpdates !== prevAutoCheck) applyAutoCheck();
  updateTrayMenu();
  return config;
});

ipcMain.handle('window:setLocked', (_e, locked: boolean) => {
  config.locked = !!locked;
  saveConfig();
  applyLock();
  return config.locked;
});

ipcMain.handle('window:resizeBy', (_e, dx: number, dy: number) => {
  if (!win) return null;
  const b = win.getBounds();
  win.setBounds({
    x: b.x,
    y: b.y,
    width: Math.max(220, Math.round(b.width + dx)),
    height: Math.max(120, Math.round(b.height + dy)),
  });
  return win.getBounds();
});

ipcMain.handle('app:quit', () => app.quit());

ipcMain.handle('update:check', () => checkForUpdates(true));

// Errors come back as { error } rather than a rejection so the renderer shows
// our message, not Electron's "Error invoking remote method …" wrapper.
ipcMain.handle('update:apply', async () => {
  try {
    if (!pendingUpdate) throw new Error('nothing to update to');
    if (!pendingUpdate.url) {
      // Release carries no payload asset — the runtime itself must have changed.
      void shell.openExternal(pendingUpdate.page ?? RELEASES_PAGE);
      return { manual: true };
    }
    if (stagedVersion === pendingUpdate.version) {
      // Already on disk from an earlier click; only the restart is missing.
      return { staged: true, version: stagedVersion };
    }
    const staged = await updater.download(pendingUpdate.url, pendingUpdate.version);
    stagedVersion = staged.version;
    return { staged: true, version: staged.version };
  } catch (err) {
    const message = (err as Error).message;
    console.warn('update failed:', message);
    return { error: message };
  }
});

/** Restart through app.quit() so will-quit still saves config and drops hotkeys. */
ipcMain.handle('update:restart', () => {
  app.relaunch();
  app.quit();
});

ipcMain.handle('update:version', () => ({
  version: handoff?.version ?? app.getVersion(),
  bundled: handoff?.bundledVersion ?? null,
  usingStaged: !!handoff?.usingStaged,
}));

ipcMain.on('renderer:ready', (e) => {
  // boot counts launches until we report in; the renderer being up is the signal.
  if (win && !win.isDestroyed() && e.sender === win.webContents) handoff?.markHealthy();
});

ipcMain.handle('shell:open', (_e, url: string) => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
});

/**
 * HTTP GET performed in the main process so the renderer never hits CORS.
 * Restricted to the emote/badge metadata hosts.
 */
export const ALLOWED_HOSTS = new Set([
  'goodgame.ru',
  'api2.goodgame.ru',
  'static.goodgame.ru',
  '7tv.io',
  'api.betterttv.net',
  'api.frankerfacez.com',
  'api.ivr.fi',
]);

ipcMain.handle('env:endpoints', () => resolveEndpoints(process.env));

ipcMain.handle('http:json', async (_e, url: string) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('bad url');
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error('host not allowed: ' + parsed.hostname);
  }
  // The allowlist is checked against the real host first, so the override can
  // only ever redirect a request the app was already allowed to make.
  url = rewriteApiUrl(url, process.env['OVERLAY_TEST_API_BASE']);
  const res = await net.fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'ChatOverlay/1.0' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
});

/* -------------------------------------------------------------------- boot */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      config.hidden = false;
      applyHidden();
    }
  });

  void app.whenReady().then(() => {
    loadConfig();
    createWindow();
    createTray();
    registerShortcuts();
    applyAutoCheck();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    saveConfig();
  });
}

export { activeSources };
