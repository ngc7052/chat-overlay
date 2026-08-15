import type { Config, SourceConfig } from '../main/types.js';
import { createAssetApi } from './emotes/index.js';
import { GoodGameSource } from './sources/goodgame.js';
import { TwitchSource } from './sources/twitch.js';
import type { BaseSource } from './sources/base.js';
import type { ChatMessage, ConnectionState, RemoveRequest } from './sources/types.js';
import { debounce, timeString, type MessagePart } from './util.js';
import {
  appearanceVars, badgeRendering, emptyHint, messagesToRemove, platformIconPath, platformMarker,
  shouldDrop, sourceDotClass, statusLine, visibleBadges, type SourceStatus,
} from './view.js';

/** DOM wiring. The rules it applies live in ./view and ./sources. */

interface OverlayApi {
  getConfig(): Promise<Config>;
  setConfig(patch: Partial<Config>): Promise<Config>;
  setLocked(locked: boolean): Promise<boolean>;
  resizeBy(dx: number, dy: number): Promise<unknown>;
  quit(): Promise<void>;
  httpJson(url: string): Promise<unknown>;
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
const statusEl = $('status');
const settingsEl = $<HTMLDivElement>('settings');
const sourcesEl = $('sources');
const hotkeyWarn = $('hotkey-warn');
const settingsBtn = $<HTMLButtonElement>('btn-settings');
const updateBtn = $<HTMLButtonElement>('btn-update');
const applyBtn = $<HTMLButtonElement>('btn-apply-update');
const checkBtn = $<HTMLButtonElement>('btn-check-update');
const updateStatus = $('update-status');

let config: Config;
let sources: BaseSource[] = [];
const states = new Map<string, SourceStatus>();
const nodes = new Map<string, { el: HTMLElement; timer: ReturnType<typeof setTimeout> | null }>();
let autoScroll = true;

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
  document.body.style.opacity = String(config.opacity);
  trimMessages();
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

chatEl.addEventListener('scroll', () => {
  autoScroll = chatEl.scrollHeight - chatEl.clientHeight - chatEl.scrollTop < 24;
});

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
      const span = document.createElement('span');
      span.className = 'url';
      span.textContent = p.value;
      container.appendChild(span);
    } else {
      container.appendChild(document.createTextNode(p.value));
    }
  }
}

function addMessage(msg: ChatMessage): void {
  if (nodes.has(msg.id) || shouldDrop(msg, config)) return;

  const el = document.createElement('div');
  el.className = 'msg' + (msg.kind === 'system' ? ' system' : '') +
    (msg.kind === 'event' ? ' event' : '') + (msg.action ? ' action' : '');
  el.dataset['user'] = msg.userLogin || '';
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
    tag.className = 'plat ' + (msg.platform === 'twitch' ? 'tw' : 'gg');
    tag.textContent = msg.platform === 'twitch' ? 'TW' : 'GG';
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

  chatEl.appendChild(el);

  const entry: { el: HTMLElement; timer: ReturnType<typeof setTimeout> | null } = { el, timer: null };
  if (config.messageLifetime > 0) {
    entry.timer = setTimeout(() => {
      el.classList.add('fading');
      setTimeout(() => removeMessage(msg.id), config.fadeDuration * 1000 + 60);
    }, config.messageLifetime * 1000);
  }
  nodes.set(msg.id, entry);

  trimMessages();
  if (autoScroll) scrollToBottom();
}

function removeMessage(id: string): void {
  const entry = nodes.get(id);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.el.remove();
  nodes.delete(id);
}

function trimMessages(): void {
  while (nodes.size > config.maxMessages) {
    const oldest = nodes.keys().next().value;
    if (oldest === undefined) break;
    removeMessage(oldest);
  }
}

function handleRemove(req: RemoveRequest): void {
  const rendered = Array.from(nodes.entries()).map(([id, entry]) => ({
    id,
    platform: entry.el.dataset['platform'] ?? '',
    channel: entry.el.dataset['channel'] ?? '',
    user: entry.el.dataset['user'] ?? '',
  }));
  messagesToRemove(req, rendered).forEach(removeMessage);
}

function clearAll(): void {
  for (const id of Array.from(nodes.keys())) removeMessage(id);
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

function renderStatus(): void {
  statusEl.textContent = statusLine(
    sources.map((s) => ({ key: s.key, platform: s.platform, channel: s.channel })),
    states,
  );
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
      onMessage: addMessage,
      onRemove: handleRemove,
      onStatus: (src: { key: string }, state: ConnectionState, detail: string) => {
        states.set(src.key, { state, detail });
        renderStatus();
      },
      getConfig,
      assets,
      httpJson: (url: string) => overlay.httpJson(url),
      onWarn: (m: string) => console.warn(m),
    };
    const src = cfgSrc.platform === 'twitch' ? new TwitchSource(opts) : new GoodGameSource(opts);
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
  for (const [value, label] of [['goodgame', 'GoodGame'], ['twitch', 'Twitch']] as const) {
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

settingsBtn.addEventListener('click', () => showSettings(settingsEl.hidden));
$('btn-settings-close').addEventListener('click', () => showSettings(false));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsEl.hidden) showSettings(false);
});
$('btn-add-source').addEventListener('click', () => {
  config.sources.push({ platform: 'twitch', channel: '', enabled: true });
  persist({ sources: config.sources });
  renderSourceRows();
});
$('btn-lock').addEventListener('click', () => void overlay.setLocked(true));
$('btn-reconnect').addEventListener('click', () => { clearAll(); rebuildSources(); });
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
  updateBtn.textContent = 'Update to ' + info.version;
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
  updateBtn.textContent = 'Downloading…';
  const res = await overlay.updateApply();
  if (res.error) {
    setUpdateStatus('Update failed: ' + res.error);
    systemLine('Update failed: ' + res.error);
    applyBtn.textContent = label;
    updateBtn.textContent = 'Update to ' + available.version;
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
overlay.onReconnect(() => { clearAll(); rebuildSources(); });
overlay.onHotkeys((ok) => {
  const failed: string[] = [];
  if (!ok.lock) failed.push(config.hotkeyLock);
  if (!ok.hide) failed.push(config.hotkeyHide);
  hotkeyWarn.hidden = failed.length === 0;
  hotkeyWarn.textContent = failed.length
    ? 'Could not register: ' + failed.join(', ') + ' — another app already owns it. Pick a different combo.'
    : '';
});

void overlay.getConfig().then((cfg) => {
  config = cfg;
  applyCustomCss();
  applyAppearance();
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
