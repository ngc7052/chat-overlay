import type { Config, SourceConfig } from '../main/types.js';
import { createAssetApi } from './emotes/index.js';
import { GoodGameSource } from './sources/goodgame.js';
import { TwitchSource } from './sources/twitch.js';
import { YouTubeSource } from './sources/youtube.js';
import type { BaseSource } from './sources/base.js';
import type { ChatMessage, ConnectionState, RemoveRequest } from './sources/types.js';
import { debounce, timeString, type MessagePart } from './util.js';
import { Feed } from './feed.js';
import {
  appearanceVars, badgeRendering, barAlert, emptyHint, pinnedToBottom, platformIconPath,
  platformMarker, platformTag, sourceDotClass, statusDots, visibleBadges,
  type BarAlert, type SourceStatus,
} from './view.js';

/** DOM wiring. The rules it applies live in ./view and ./sources. */

interface OverlayApi {
  getConfig(): Promise<Config>;
  setConfig(patch: Partial<Config>): Promise<Config>;
  setLocked(locked: boolean): Promise<boolean>;
  resizeBy(dx: number, dy: number): Promise<unknown>;
  quit(): Promise<void>;
  openExternal(url: string): Promise<void>;
  httpJson(url: string): Promise<unknown>;
  httpText(url: string): Promise<string>;
  httpPost(url: string, body: unknown): Promise<unknown>;
  endpoints(): Promise<{
    twitchWs: string | null; goodgameWs: string | null;
    ggIconBase: string | null; ggChannelIconBase: string | null; twitchEmoteBase: string | null;
    watchdogMs: number | null;
    alertMs: number | null;
  }>;
  updateVersion(): Promise<{ version: string; bundled: string | null; usingStaged: boolean }>;
  updateCheck(): Promise<{ error?: string; newer?: boolean; current?: string; version?: string }>;
  updateApply(): Promise<{ error?: string; manual?: boolean; staged?: boolean; version?: string }>;
  updateRestart(): Promise<void>;
  rendererReady(): void;
  onUpdateAvailable(cb: (info: UpdateInfo) => void): void;
  onUpdateNone(cb: (info: { current: string }) => void): void;
  onUpdateError(cb: (msg: string) => void): void;
  onLocked(cb: (locked: boolean) => void): void;
  onHotkeys(cb: (s: { lock: boolean; hide: boolean }) => void): void;
  onReconnect(cb: () => void): void;
  onPointerOver(cb: (over: boolean) => void): void;
}

interface UpdateInfo {
  version: string;
  current: string;
  quarantined?: boolean;
  staged?: boolean;
}

declare global {
  interface Window { overlay: OverlayApi }
}

const overlay = window.overlay;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const chatEl = $('chat');
const listEl = $('src-list');
const alertEl = $('src-alert');
const alertTextEl = $('alert-text');
const settingsEl = $<HTMLDivElement>('settings');
const sourcesEl = $('sources');
const hotkeyWarn = $('hotkey-warn');
const settingsBtn = $<HTMLButtonElement>('btn-settings');
const updateBtn = $<HTMLButtonElement>('btn-update');
// The button's text lives in its own span: writing to the button itself would
// replace its children, icon included.
const updateLabel = $('update-label');
const lockBtn = $<HTMLButtonElement>('btn-lock');
const applyBtn = $<HTMLButtonElement>('btn-apply-update');
const checkBtn = $<HTMLButtonElement>('btn-check-update');
const updateStatus = $('update-status');

let config: Config;
let endpoints: {
  twitchWs: string | null; goodgameWs: string | null;
  ggIconBase: string | null; ggChannelIconBase: string | null; twitchEmoteBase: string | null;
  watchdogMs: number | null;
  alertMs: number | null;
} = {
  twitchWs: null, goodgameWs: null, ggIconBase: null, ggChannelIconBase: null,
  twitchEmoteBase: null, watchdogMs: null, alertMs: null,
};
let sources: BaseSource[] = [];
const states = new Map<string, SourceStatus>();
let autoScroll = true;

/**
 * The feed itself. Everything about *when* a message reaches the screen lives
 * in ./feed; this is only the DOM half of it — build an element, put a batch
 * in, take one out.
 *
 * The frame is what the batching hangs off: a poll that hands over three
 * hundred messages at once becomes one build, one insert, one trim and one
 * scroll instead of three hundred of each. `backgroundThrottling` is off for
 * this window, so the frame keeps coming even when nothing is on top of it.
 */
const feed = new Feed<HTMLElement, ReturnType<typeof setTimeout>>({
  build: buildMessage,
  insert: (els) => {
    const batch = document.createDocumentFragment();
    for (const el of els) batch.appendChild(el);
    chatEl.appendChild(batch);
  },
  detach: (el) => el.remove(),
  fade: (el) => el.classList.add('fading'),
  schedule: (flush) => requestAnimationFrame(flush),
  // The one layout read per batch, and the only place it happens.
  painted: () => { if (autoScroll) scrollToBottom(); },
  config: () => config,
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle),
});

const getConfig = () => config;
const assets = createAssetApi({
  httpJson: (url) => overlay.httpJson(url),
  storage: typeof localStorage === 'undefined' ? null : localStorage,
  onWarn: (m) => console.warn(m),
});

/* ------------------------------------------------------------- appearance */

// Constructable stylesheet: lets user CSS in without an inline <style>, which
// the page's CSP (style-src 'self') would refuse.
const customSheet = new CSSStyleSheet();
document.adoptedStyleSheets = [...document.adoptedStyleSheets, customSheet];

function applyCustomCss(): string {
  try {
    customSheet.replaceSync(config.customCss || '');
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

function applyAppearance(): void {
  const root = document.documentElement.style;
  for (const [name, value] of Object.entries(appearanceVars(config))) {
    root.setProperty(name, value);
  }
  document.body.classList.toggle('outline', config.outline);
  // The feed only. On <body> it faded the settings panel too, so dragging the
  // slider to its floor left the control needed to drag it back at 20% over
  // whatever game is behind it.
  chatEl.style.opacity = String(config.opacity);
  trimMessages();
}

/** The lock button names the hotkey that undoes it, so it has to follow config. */
function applyHotkeyHints(): void {
  const accel = config.hotkeyLock.trim();
  lockBtn.title = 'Hide the bar and let clicks pass through' + (accel ? ' (' + accel + ')' : '');
}

function applyLocked(locked: boolean): void {
  document.body.classList.toggle('locked', locked);
  if (locked) {
    showSettings(false);
    autoScroll = true;
    scrollToBottom();
  }
}

/* --------------------------------------------------------------- messages */

function scrollToBottom(): void {
  chatEl.scrollTop = chatEl.scrollHeight;
}

chatEl.addEventListener('scroll', () => { autoScroll = pinnedToBottom(chatEl); });

function chip(text: string, kind: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'badge ' + (kind || 'generic');
  el.textContent = text;
  return el;
}

function renderParts(container: HTMLElement, parts: MessagePart[]): void {
  for (const p of parts) {
    if (p.type === 'emote') {
      const img = document.createElement('img');
      img.className = 'emote';
      img.src = p.url;
      img.alt = p.name;
      img.title = p.name;
      img.loading = 'lazy';
      if (p.fallback) {
        const fallback = p.fallback;
        img.addEventListener('error', () => { img.src = fallback; }, { once: true });
      }
      container.appendChild(img);
    } else if (p.type === 'url') {
      const link = document.createElement('span');
      link.className = 'url';
      link.textContent = p.value;
      link.title = 'Open in your browser';
      const href = p.value;
      link.addEventListener('click', () => {
        // Locked, the window is click-through and the game gets the click —
        // which is the whole point of the app. Only unlocked links open.
        if (document.body.classList.contains('locked')) return;
        // A drag that selected the link was a copy, not a click.
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) return;
        void overlay.openExternal(href);
      });
      container.appendChild(link);
    } else {
      container.appendChild(document.createTextNode(p.value));
    }
  }
}

/** One message's element. Built, not inserted — the feed decides when. */
function buildMessage(msg: ChatMessage): HTMLElement {
  const el = document.createElement('div');
  el.className = 'msg' + (msg.kind === 'system' ? ' system' : '') +
    (msg.kind === 'event' ? ' event' : '') + (msg.action ? ' action' : '');
  el.dataset['user'] = msg.userLogin || '';
  // The unique one where the platform has one; a removal by author prefers it.
  el.dataset['userid'] = msg.userId || '';
  el.dataset['platform'] = msg.platform;
  el.dataset['channel'] = msg.channel || '';

  if (config.showTimestamps) {
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = timeString(msg.ts);
    el.appendChild(ts);
  }

  const marker = platformMarker(msg, config);
  if (marker === 'icon') {
    const img = document.createElement('img');
    img.className = 'plat-img';
    img.src = platformIconPath(msg.platform);
    img.alt = msg.platform;
    img.title = msg.platform + ' / ' + msg.channel;
    el.appendChild(img);
  } else if (marker === 'text') {
    const tag = document.createElement('span');
    const short = platformTag(msg.platform);
    tag.className = 'plat ' + short;
    tag.textContent = short.toUpperCase();
    tag.title = msg.platform + ' / ' + msg.channel;
    el.appendChild(tag);
  }

  if (msg.kind === 'chat') {
    for (const b of visibleBadges(msg, config)) {
      if (badgeRendering(b, config) === 'image' && b.url) {
        const img = document.createElement('img');
        img.className = 'badge-img';
        img.src = b.url;
        img.alt = b.title || b.label;
        img.title = b.title || b.label;
        img.addEventListener('error', () => img.replaceWith(chip(b.label, b.kind)), { once: true });
        el.appendChild(img);
      } else {
        el.appendChild(chip(b.label, b.kind));
      }
    }

    const name = document.createElement('span');
    name.className = 'name';
    name.style.color = msg.color;
    name.textContent = msg.user;
    el.appendChild(name);

    const colon = document.createElement('span');
    colon.className = 'colon';
    colon.textContent = msg.action ? ' ' : ':';
    el.appendChild(colon);
  }

  const text = document.createElement('span');
  text.className = 'text';
  if (msg.action) text.style.color = msg.color;
  renderParts(text, msg.parts);
  el.appendChild(text);

  return el;
}

function addMessage(msg: ChatMessage): void {
  feed.add(msg);
}

function trimMessages(): void {
  feed.trim();
}

function handleRemove(req: RemoveRequest): void {
  feed.apply(req);
}

function clearAll(): void {
  feed.clear();
}

function systemLine(text: string): void {
  addMessage({
    id: 'sys:' + Date.now() + ':' + Math.random().toString(36).slice(2, 7),
    platform: 'goodgame',
    channel: '',
    user: '',
    userLogin: '',
    color: '#b9c6dc',
    badges: [],
    parts: [{ type: 'text', value: text }],
    kind: 'system',
    ts: Date.now(),
  });
}

/* ---------------------------------------------------------------- status */

function reconnectAll(): void {
  clearAll();
  rebuildSources();
}

/**
 * How long a connection may be down before the bar says so.
 *
 * Chat sockets drop and come back several times an evening; shouting about a
 * blip that fixed itself in a second is exactly the noise this design exists
 * to remove. Long enough to sit out an ordinary reconnect, short enough that a
 * user who has noticed the silence and looked up has an answer waiting.
 */
const ALERT_GRACE_MS = 4000;

let alertTimer: ReturnType<typeof setTimeout> | null = null;

/** Paint the exception, once it has lasted long enough to be one. */
function applyAlert(alert: BarAlert): void {
  alertEl.title = alert.title;
  alertTextEl.textContent = alert.text;
  const showing = !alertEl.hidden;
  const set = (): void => {
    document.body.classList.toggle('status-warn', alert.level === 'warn');
    document.body.classList.toggle('status-down', alert.level === 'down');
    alertEl.hidden = alert.level === 'ok';
  };
  if (alertTimer) { clearTimeout(alertTimer); alertTimer = null; }
  // Recovering is instant; only going wrong waits. And once the bar is already
  // saying something, a change of what it says is not a fresh alarm.
  if (alert.level === 'ok' || showing) { set(); return; }
  alertTimer = setTimeout(set, endpoints.alertMs ?? ALERT_GRACE_MS);
}

function renderStatus(): void {
  const dots = statusDots(
    sources.map((s) => ({ key: s.key, platform: s.platform, channel: s.channel })),
    states,
  );
  // One pair per channel — the dot sits immediately left of the name it stands
  // for — plus the alert, which is the only thing painted at rest and is drawn
  // over the row rather than in it. See style.css.
  const list = dots.map((d) => {
    const pair = document.createElement('span');
    pair.className = 'src-pair';
    const dot = document.createElement('span');
    dot.className = 'src-dot ' + d.state;
    dot.title = d.title;
    const name = document.createElement('span');
    name.className = 'src-name';
    name.textContent = d.label;
    pair.append(dot, name);
    return pair;
  });
  listEl.replaceChildren(...list);
  applyAlert(barAlert(dots));
  refreshSourceDots();
}

/* --------------------------------------------------------------- sources */

function rebuildSources(): void {
  sources.forEach((s) => s.destroy());
  sources = [];
  states.clear();

  for (const cfgSrc of config.sources) {
    if (!cfgSrc.enabled || !cfgSrc.channel) continue;
    const opts = {
      channel: cfgSrc.channel.trim(),
      // YouTube has no socket to point anywhere; the other two are named here.
      wsUrl: cfgSrc.platform === 'twitch' ? endpoints.twitchWs
        : cfgSrc.platform === 'youtube' ? null : endpoints.goodgameWs,
      iconBase: endpoints.ggIconBase,
      channelIconBase: endpoints.ggChannelIconBase,
      emoteBase: endpoints.twitchEmoteBase,
      watchdogMs: endpoints.watchdogMs,
      onMessage: addMessage,
      onRemove: handleRemove,
      onStatus: (src: { key: string }, state: ConnectionState, detail: string) => {
        states.set(src.key, { state, detail });
        renderStatus();
      },
      getConfig,
      assets,
      httpJson: (url: string) => overlay.httpJson(url),
      httpText: (url: string) => overlay.httpText(url),
      httpPost: (url: string, body: unknown) => overlay.httpPost(url, body),
      onWarn: (m: string) => console.warn(m),
    };
    const src = cfgSrc.platform === 'twitch'
      ? new TwitchSource(opts)
      : cfgSrc.platform === 'youtube'
        ? new YouTubeSource(opts)
        : new GoodGameSource(opts);
    sources.push(src);
    states.set(src.key, { state: 'connecting', detail: '' });
    void src.connect();
  }

  if (sources.length === 0) systemLine(emptyHint(config.sources));
  renderStatus();
}

const rebuildDebounced = debounce(rebuildSources, 700);

/* -------------------------------------------------------------- settings */

const RANGE_FIELDS: [keyof Config, (v: number) => string][] = [
  ['fontSize', (v) => v + 'px'],
  ['fontWeight', (v) => String(v)],
  ['opacity', (v) => Math.round(v * 100) + '%'],
  ['bgOpacity', (v) => Math.round(v * 100) + '%'],
  ['hoverBgOpacity', (v) => Math.round(v * 100) + '%'],
  ['emoteScale', (v) => v + '×'],
  ['maxMessages', (v) => String(v)],
  ['messageLifetime', (v) => (v === 0 ? 'never' : v + 's')],
];

const CHECK_FIELDS: (keyof Config)[] = [
  'outline', 'showTimestamps', 'boldNames', 'exactColors', 'showSystem',
  'emotes', 'thirdPartyEmotes', 'hideCommands', 'autoCheckUpdates',
];

function persist(patch: Partial<Config>): void {
  void overlay.setConfig(patch).catch((err: Error) => console.warn('save failed', err));
}

function bindSettings(): void {
  for (const [key, fmt] of RANGE_FIELDS) {
    const input = $<HTMLInputElement>(key as string);
    const out = $<HTMLOutputElement>('out-' + (key as string));
    input.value = String(config[key]);
    out.textContent = fmt(config[key] as number);
    input.addEventListener('input', () => {
      (config[key] as number) = Number(input.value);
      out.textContent = fmt(config[key] as number);
      applyAppearance();
      persist({ [key]: config[key] } as Partial<Config>);
    });
  }

  for (const key of CHECK_FIELDS) {
    const input = $<HTMLInputElement>(key as string);
    input.checked = Boolean(config[key]);
    input.addEventListener('change', () => {
      (config[key] as boolean) = input.checked;
      applyAppearance();
      persist({ [key]: config[key] } as Partial<Config>);
      if (key === 'emotes' || key === 'thirdPartyEmotes' || key === 'exactColors') rebuildDebounced();
    });
  }

  for (const key of ['badgeStyle', 'platformStyle'] as const) {
    const sel = $<HTMLSelectElement>(key);
    sel.value = config[key];
    sel.addEventListener('change', () => {
      (config[key] as string) = sel.value;
      persist({ [key]: sel.value } as Partial<Config>);
    });
  }

  const ignore = $<HTMLInputElement>('ignoreList');
  ignore.value = config.ignoreList.join(', ');
  ignore.addEventListener('input', () => {
    config.ignoreList = ignore.value.split(',').map((s) => s.trim()).filter(Boolean);
    persist({ ignoreList: config.ignoreList });
  });

  for (const key of ['hotkeyLock', 'hotkeyHide'] as const) {
    const input = $<HTMLInputElement>(key);
    input.value = config[key];
    input.addEventListener('change', () => {
      config[key] = input.value.trim();
      applyHotkeyHints();
      persist({ [key]: config[key] } as Partial<Config>);
    });
  }

  // Font: the preset dropdown writes into the free-text field, which is the truth.
  const fontFamily = $<HTMLInputElement>('fontFamily');
  const fontPreset = $<HTMLSelectElement>('fontPreset');
  const syncPreset = () => {
    const match = Array.from(fontPreset.options).find((o) => o.value === config.fontFamily);
    fontPreset.value = match ? match.value : '__custom';
  };
  fontFamily.value = config.fontFamily;
  syncPreset();
  fontPreset.addEventListener('change', () => {
    if (fontPreset.value === '__custom') return;
    config.fontFamily = fontPreset.value;
    fontFamily.value = fontPreset.value;
    applyAppearance();
    persist({ fontFamily: config.fontFamily });
  });
  fontFamily.addEventListener('input', () => {
    config.fontFamily = fontFamily.value.trim() || "'Segoe UI', system-ui, sans-serif";
    applyAppearance();
    syncPreset();
    persist({ fontFamily: config.fontFamily });
  });

  const cssBox = $<HTMLTextAreaElement>('customCss');
  const cssError = $('css-error');
  cssBox.value = config.customCss;
  cssBox.addEventListener('input', () => {
    config.customCss = cssBox.value;
    const err = applyCustomCss();
    cssError.hidden = !err;
    cssError.textContent = err ? 'CSS rejected: ' + err : '';
    persist({ customCss: config.customCss });
  });
}

function renderSourceRows(): void {
  sourcesEl.textContent = '';
  if (config.sources.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint empty';
    empty.textContent = 'No channels yet. Add one below, then tick it to connect.';
    sourcesEl.appendChild(empty);
    return;
  }
  config.sources.forEach((src, index) => sourcesEl.appendChild(buildSourceRow(src, index)));
  refreshSourceDots();
}

function refreshSourceDots(): void {
  Array.from(sourcesEl.children).forEach((row, index) => {
    const dot = row.querySelector('.dot');
    if (!dot) return;
    const src = config.sources[index];
    const key = src ? src.platform + ':' + src.channel.toLowerCase() : '';
    const status = states.get(key);
    dot.className = sourceDotClass(src, status);
    (dot as HTMLElement).title = src?.enabled === false
      ? 'disabled'
      : status ? status.state + (status.detail ? ' — ' + status.detail : '') : 'not connected';
  });
}

function buildSourceRow(src: SourceConfig, index: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'src-row';

  const dot = document.createElement('span');
  dot.className = 'dot';
  row.appendChild(dot);

  const enable = document.createElement('input');
  enable.type = 'checkbox';
  enable.checked = src.enabled !== false;
  enable.title = 'Connect to this channel';
  enable.addEventListener('change', () => {
    const target = config.sources[index];
    if (!target) return;
    target.enabled = enable.checked;
    persist({ sources: config.sources });
    rebuildSources();
  });
  row.appendChild(enable);

  const select = document.createElement('select');
  for (const [value, label] of [['goodgame', 'GoodGame'], ['twitch', 'Twitch'], ['youtube', 'YouTube']] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  }
  select.value = src.platform;
  select.addEventListener('change', () => {
    const target = config.sources[index];
    if (!target) return;
    target.platform = select.value as SourceConfig['platform'];
    persist({ sources: config.sources });
    rebuildDebounced();
  });
  row.appendChild(select);

  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = 'channel name';
  input.value = src.channel;
  input.addEventListener('input', () => {
    const target = config.sources[index];
    if (!target) return;
    target.channel = input.value.trim();
    persist({ sources: config.sources });
    rebuildDebounced();
  });
  row.appendChild(input);

  const del = document.createElement('button');
  del.textContent = '✕';
  del.title = 'Remove channel';
  del.addEventListener('click', () => {
    config.sources.splice(index, 1);
    persist({ sources: config.sources });
    renderSourceRows();
    rebuildSources();
  });
  row.appendChild(del);

  return row;
}

/* ------------------------------------------------------------ chrome/UI */

function showSettings(show: boolean): void {
  settingsEl.hidden = !show;
  // Swaps the cog for a back arrow and marks the button as active.
  document.body.classList.toggle('settings-open', show);
  settingsBtn.title = show ? 'Back to chat' : 'Settings';
  if (!show && autoScroll) scrollToBottom();
}

// `hidden` is boolean | "until-found" in current DOM types, so it is coerced
// rather than passed through: anything hidden at all means "open it".
settingsBtn.addEventListener('click', () => showSettings(!!settingsEl.hidden));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsEl.hidden) showSettings(false);
});

// Which settings groups are expanded, kept between sessions. This is a view
// preference, not configuration, so it lives in localStorage rather than in
// config.json where it would need a schema and a migration.
(() => {
  const KEY = 'settings-open-groups';
  const groups = Array.from(document.querySelectorAll<HTMLDetailsElement>('#settings .group'));
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (Array.isArray(saved)) groups.forEach((g) => { g.open = saved.includes(g.id); });
  } catch { /* a corrupt entry just means the defaults stand */ }
  for (const g of groups) {
    g.addEventListener('toggle', () => {
      try {
        localStorage.setItem(KEY, JSON.stringify(groups.filter((x) => x.open).map((x) => x.id)));
      } catch { /* quota — remembering this is best effort */ }
    });
  }
})();
$('btn-add-source').addEventListener('click', () => {
  config.sources.push({ platform: 'twitch', channel: '', enabled: true });
  persist({ sources: config.sources });
  renderSourceRows();
});
$('btn-lock').addEventListener('click', () => void overlay.setLocked(true));
$('btn-reconnect').addEventListener('click', reconnectAll);
$('btn-quit').addEventListener('click', () => void overlay.quit());

// Custom resize grip: a frameless transparent window has no OS resize border.
(() => {
  const grip = $('resize');
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  grip.addEventListener('mousedown', (e) => {
    dragging = true;
    lastX = e.screenX;
    lastY = e.screenY;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.screenX - lastX;
    const dy = e.screenY - lastY;
    if (dx || dy) {
      lastX = e.screenX;
      lastY = e.screenY;
      void overlay.resizeBy(dx, dy);
    }
  });
  window.addEventListener('mouseup', () => { dragging = false; });
})();

/* --------------------------------------------------------------- updates */

let available: UpdateInfo | null = null;
let busy = false;

function setUpdateStatus(text: string): void {
  updateStatus.textContent = text;
}

async function refreshVersion(): Promise<void> {
  const v = await overlay.updateVersion();
  setUpdateStatus('Version ' + v.version);
}

function offerUpdate(info: UpdateInfo): void {
  available = info;
  updateBtn.hidden = false;
  updateLabel.textContent = 'Update to ' + info.version;
  applyBtn.hidden = false;
  applyBtn.textContent = info.staged ? 'Restart to finish' : 'Download and restart';
  setUpdateStatus('Version ' + info.current + ' — v' + info.version + ' available');
  // Locked users never see the bar, so say it in the feed too.
  if (!info.quarantined) systemLine('Version ' + info.version + ' is available — unlock and click Update.');
}

function withdrawUpdate(current: string): void {
  available = null;
  updateBtn.hidden = true;
  applyBtn.hidden = true;
  setUpdateStatus('Version ' + current + ' — up to date');
}

async function applyUpdate(): Promise<void> {
  if (busy || !available) return;
  busy = true;
  const label = applyBtn.textContent;
  applyBtn.textContent = 'Downloading…';
  updateLabel.textContent = 'Downloading…';
  const res = await overlay.updateApply();
  if (res.error) {
    setUpdateStatus('Update failed: ' + res.error);
    systemLine('Update failed: ' + res.error);
    applyBtn.textContent = label;
    updateLabel.textContent = 'Update to ' + available.version;
    busy = false;
    return;
  }
  if (res.manual) {
    setUpdateStatus('This release needs the full download — opened in your browser.');
    applyBtn.textContent = label;
    busy = false;
    return;
  }
  setUpdateStatus('v' + res.version + ' ready — restarting…');
  setTimeout(() => void overlay.updateRestart(), 600);
}

updateBtn.addEventListener('click', () => { showSettings(true); void applyUpdate(); });
applyBtn.addEventListener('click', () => void applyUpdate());
checkBtn.addEventListener('click', async () => {
  setUpdateStatus('Checking…');
  const res = await overlay.updateCheck();
  if (res.error) setUpdateStatus('Check failed: ' + res.error);
  else if (!res.newer) setUpdateStatus('Version ' + res.current + ' — up to date');
});

overlay.onUpdateAvailable(offerUpdate);
overlay.onUpdateNone((info) => withdrawUpdate(info.current));
overlay.onUpdateError((msg) => setUpdateStatus('Check failed: ' + msg));

/* ------------------------------------------------------------------ boot */

overlay.onLocked(applyLocked);
overlay.onReconnect(reconnectAll);
// Reported by the main process rather than read from CSS :hover, which a drag
// region would swallow. Drives the backdrop and the bar.
overlay.onPointerOver((over) => document.body.classList.toggle('pointer-over', over));
overlay.onHotkeys((ok) => {
  const failed: string[] = [];
  if (!ok.lock) failed.push(config.hotkeyLock);
  if (!ok.hide) failed.push(config.hotkeyHide);
  hotkeyWarn.hidden = failed.length === 0;
  hotkeyWarn.textContent = failed.length
    ? 'Could not register: ' + failed.join(', ') + ' — another app already owns it. Pick a different combo.'
    : '';
});

void Promise.all([overlay.getConfig(), overlay.endpoints()]).then(([cfg, eps]) => {
  config = cfg;
  endpoints = eps;
  applyCustomCss();
  applyAppearance();
  applyHotkeyHints();
  applyLocked(config.locked);
  bindSettings();
  renderSourceRows();
  rebuildSources();
  void refreshVersion();
  // Nothing configured yet: put the user straight where channels are added.
  if (config.sources.length === 0 && !config.locked) showSettings(true);
  // Tells boot this payload works, so a downloaded update stops being on trial.
  overlay.rendererReady();
});
