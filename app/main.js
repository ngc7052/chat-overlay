'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  Tray,
  Menu,
  net,
  nativeImage,
  screen,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');

const DEFAULT_CONFIG = {
  // Both platforms are pre-filled but switched off, so a fresh install connects
  // to nothing until the user ticks a channel in Settings.
  sources: [
    { platform: 'goodgame', channel: 'annieflowers', enabled: false },
    { platform: 'twitch', channel: 'annieflowers', enabled: false },
  ],
  bounds: { x: null, y: null, width: 420, height: 620 },
  locked: true,
  hidden: false,
  fontSize: 16,
  fontWeight: 600,
  fontFamily: "'Segoe UI', 'Inter', system-ui, sans-serif",
  opacity: 1,
  bgOpacity: 0,
  outline: true,
  showTimestamps: false,
  platformStyle: 'icon',    // 'icon' | 'text' | 'off'
  badgeStyle: 'icons',      // 'icons' | 'text' | 'off'
  boldNames: false,
  exactColors: true,        // use the exact Twitch nickname colour
  showSystem: true,
  customCss: '',
  emotes: true,
  thirdPartyEmotes: true,
  emoteScale: 1.7,
  messageLifetime: 0,
  fadeDuration: 1.2,
  maxMessages: 120,
  hideCommands: false,
  ignoreList: [],
  hotkeyLock: 'Control+Alt+O',
  hotkeyHide: 'Control+Alt+H',
};

let config = { ...DEFAULT_CONFIG };
let win = null;
let tray = null;
let saveTimer = null;

/* ------------------------------------------------------------------ config */

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    config = { ...DEFAULT_CONFIG, ...parsed };
    config.bounds = { ...DEFAULT_CONFIG.bounds, ...(parsed.bounds || {}) };
    if (!Array.isArray(config.sources) || config.sources.length === 0) {
      config.sources = DEFAULT_CONFIG.sources.map((s) => ({ ...s }));
    }
  } catch (err) {
    config = { ...DEFAULT_CONFIG, sources: DEFAULT_CONFIG.sources.map((s) => ({ ...s })) };
  }

  // showBadges (boolean) was replaced by badgeStyle ('icons'|'text'|'off').
  if (typeof config.showBadges === 'boolean') {
    if (config.showBadges === false) config.badgeStyle = 'off';
    delete config.showBadges;
  }
  // showPlatform (boolean) was replaced by platformStyle ('icon'|'text'|'off').
  if (typeof config.showPlatform === 'boolean') {
    if (config.showPlatform === false) config.platformStyle = 'off';
    delete config.showPlatform;
  }

  // A locked overlay with nothing to show is an invisible, unreachable window —
  // start unlocked so Settings is actually reachable.
  if (!config.sources.some((s) => s.enabled && s.channel)) config.locked = false;
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
    fs.writeFileSync(CONFIG_FILE(), JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('config save failed:', err.message);
  }
}

function saveConfigDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveConfig, 400);
}

/* -------------------------------------------------------------------- icon */

function loadIcon(name) {
  const file = path.join(__dirname, 'assets', name);
  const img = nativeImage.createFromPath(file);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

/* ------------------------------------------------------------------ window */

function clampToDisplay(bounds) {
  const b = { ...bounds };
  if (b.x == null || b.y == null) return b;
  const area = screen.getDisplayMatching(b).workArea;
  // Keep at least a 120x40 grab strip on screen.
  b.x = Math.min(Math.max(b.x, area.x - b.width + 120), area.x + area.width - 120);
  b.y = Math.min(Math.max(b.y, area.y), area.y + area.height - 40);
  return b;
}

function applyLock() {
  if (!win) return;
  // forward:true keeps mouse-move events flowing so hover styling still works.
  win.setIgnoreMouseEvents(!!config.locked, { forward: true });
  win.setFocusable(!config.locked);
  if (!config.locked) {
    win.showInactive();
    win.focus();
  }
  win.webContents.send('state:locked', config.locked);
  updateTrayMenu();
}

function applyHidden() {
  if (!win) return;
  if (config.hidden) win.hide();
  else win.showInactive();
  updateTrayMenu();
}

function createWindow() {
  const b = clampToDisplay(config.bounds);

  win = new BrowserWindow({
    width: b.width || 420,
    height: b.height || 620,
    x: b.x == null ? undefined : b.x,
    y: b.y == null ? undefined : b.y,
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
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    if (!config.hidden) win.showInactive();
    applyLock();
  });

  const persistBounds = () => {
    if (!win || win.isDestroyed()) return;
    const cur = win.getBounds();
    config.bounds = { x: cur.x, y: cur.y, width: cur.width, height: cur.height };
    saveConfigDebounced();
  };
  win.on('moved', persistBounds);
  win.on('resized', persistBounds);

  win.on('closed', () => {
    win = null;
  });

  // Never navigate away; open any external link in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

/* -------------------------------------------------------------------- tray */

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: config.locked ? 'Unlock (edit / move)' : 'Lock (click-through)',
        click: () => {
          config.locked = !config.locked;
          saveConfig();
          applyLock();
        },
        accelerator: config.hotkeyLock,
      },
      {
        label: config.hidden ? 'Show overlay' : 'Hide overlay',
        click: () => {
          config.hidden = !config.hidden;
          saveConfig();
          applyHidden();
        },
        accelerator: config.hotkeyHide,
      },
      { type: 'separator' },
      {
        label: 'Reconnect all sources',
        click: () => win && win.webContents.send('action:reconnect'),
      },
      {
        label: 'Open config folder',
        click: () => shell.openPath(app.getPath('userData')),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
  tray.setToolTip(
    'ChatOverlay — ' + (config.locked ? 'locked (click-through)' : 'unlocked') +
      '\n' + config.hotkeyLock + ' toggles'
  );
}

function createTray() {
  let img = loadIcon('tray.png');
  if (img.isEmpty()) img = loadIcon('icon.png');
  tray = new Tray(img);
  updateTrayMenu();
  tray.on('click', () => {
    config.locked = !config.locked;
    saveConfig();
    applyLock();
  });
}

/* --------------------------------------------------------------- shortcuts */

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const reg = (accel, fn) => {
    if (!accel) return true;
    try {
      return globalShortcut.register(accel, fn);
    } catch (err) {
      return false;
    }
  };
  const okLock = reg(config.hotkeyLock, () => {
    config.locked = !config.locked;
    saveConfig();
    applyLock();
  });
  const okHide = reg(config.hotkeyHide, () => {
    config.hidden = !config.hidden;
    saveConfig();
    applyHidden();
  });
  if (win && !win.isDestroyed()) {
    win.webContents.send('state:hotkeys', { lock: okLock, hide: okHide });
  }
}

/* --------------------------------------------------------------------- IPC */

ipcMain.handle('config:get', () => config);

ipcMain.handle('config:set', (_e, patch) => {
  const prevLock = config.locked;
  const prevHotkeys = config.hotkeyLock + '|' + config.hotkeyHide;
  config = { ...config, ...patch };
  saveConfig();
  if (config.locked !== prevLock) applyLock();
  if (config.hotkeyLock + '|' + config.hotkeyHide !== prevHotkeys) registerShortcuts();
  updateTrayMenu();
  return config;
});

ipcMain.handle('window:setLocked', (_e, locked) => {
  config.locked = !!locked;
  saveConfig();
  applyLock();
  return config.locked;
});

ipcMain.handle('window:resizeBy', (_e, dx, dy) => {
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

ipcMain.handle('window:moveBy', (_e, dx, dy) => {
  if (!win) return null;
  const b = win.getBounds();
  win.setBounds({ ...b, x: Math.round(b.x + dx), y: Math.round(b.y + dy) });
  return win.getBounds();
});

ipcMain.handle('app:quit', () => app.quit());

ipcMain.handle('shell:open', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

/**
 * HTTP GET performed in the main process so the renderer never hits CORS.
 * Only used for the emote/channel metadata endpoints listed below.
 */
const ALLOWED_HOSTS = new Set([
  'goodgame.ru',
  'api2.goodgame.ru',
  'static.goodgame.ru',
  '7tv.io',
  'api.betterttv.net',
  'api.frankerfacez.com',
  'api.ivr.fi',
]);

ipcMain.handle('http:json', async (_e, url) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error('bad url');
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error('host not allowed: ' + parsed.hostname);
  }
  const res = await net.fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'ChatOverlay/1.0',
    },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.json();
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

  app.whenReady().then(() => {
    loadConfig();
    createWindow();
    createTray();
    registerShortcuts();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    saveConfig();
  });
}
