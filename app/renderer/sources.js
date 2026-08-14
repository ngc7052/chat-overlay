'use strict';

/*
 * Chat sources. Each one owns a WebSocket, normalises what it receives into a
 * common message shape, and hands it to `onMessage`.
 *
 * Normalised message:
 *   { id, platform, channel, userId, user, userLogin, color, badges[],
 *     parts[], action, kind: 'chat'|'system'|'event', ts }
 *
 * Both protocols are read-only and anonymous — no login, no token, no OAuth.
 *   GoodGame : wss://chat.goodgame.ru/chat2/     (JSON, `join` by numeric id)
 *   Twitch   : wss://irc-ws.chat.twitch.tv:443   (IRC, justinfan anon nick)
 */

/* ------------------------------------------------------------------ shared */

class BaseSource {
  constructor(opts) {
    this.channel = opts.channel;
    this.onMessage = opts.onMessage;
    this.onRemove = opts.onRemove || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.getConfig = opts.getConfig;
    this.ws = null;
    this.dead = false;
    this.attempt = 0;
    this.retryTimer = null;
    this.emoteMap = new Map();
    this.badgeMap = new Map();
  }

  get key() {
    return this.platform + ':' + this.channel.toLowerCase();
  }

  status(state, detail) {
    this.onStatus(this, state, detail || '');
  }

  system(text, kind) {
    this.onMessage({
      id: this.key + ':sys:' + Date.now() + ':' + Math.random().toString(36).slice(2, 7),
      platform: this.platform,
      channel: this.channel,
      user: '',
      userLogin: '',
      color: '#b9c6dc',
      badges: [],
      parts: [{ type: 'text', value: text }],
      kind: kind || 'system',
      ts: Date.now(),
    });
  }

  scheduleRetry() {
    if (this.dead) return;
    this.attempt += 1;
    const wait = Math.min(30000, 1000 * Math.pow(1.7, Math.min(this.attempt, 8)));
    const jitter = Math.round(wait * 0.25 * Math.random());
    this.status('connecting', `retry in ${Math.round((wait + jitter) / 1000)}s`);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), wait + jitter);
  }

  closeSocket() {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch (err) { /* already gone */ }
  }

  destroy() {
    this.dead = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.keepalive);
    this.closeSocket();
  }
}

/* --------------------------------------------------------------- GoodGame */

class GoodGameSource extends BaseSource {
  constructor(opts) {
    super(opts);
    this.platform = 'goodgame';
    this.channelId = null;
    this.channelTitle = '';
  }

  async resolveChannelId() {
    if (/^\d+$/.test(this.channel)) return this.channel;
    const url = 'https://goodgame.ru/api/getchannelstatus?fmt=json&id=' +
      encodeURIComponent(this.channel);
    const data = await window.overlay.httpJson(url);
    const first = data && typeof data === 'object' ? Object.values(data)[0] : null;
    if (!first || !first.stream_id) throw new Error('channel not found');
    this.channelTitle = first.key || this.channel;
    return String(first.stream_id);
  }

  async connect() {
    if (this.dead) return;
    this.closeSocket();
    this.status('connecting');

    try {
      if (!this.channelId) this.channelId = await this.resolveChannelId();
    } catch (err) {
      this.status('error', 'channel lookup failed: ' + err.message);
      this.scheduleRetry();
      return;
    }

    // Emotes are optional — a failure here must not stop the chat.
    Emotes.goodgame(this.channelId)
      .then((map) => { this.emoteMap = map; })
      .catch((err) => console.warn('gg smiles failed:', err.message));

    const ws = new WebSocket('wss://chat.goodgame.ru/chat2/');
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      ws.send(JSON.stringify({
        type: 'join',
        data: { channel_id: String(this.channelId), hidden: false },
      }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (err) { return; }
      this.handle(msg);
    };

    ws.onerror = () => this.status('error', 'socket error');

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.status('offline');
      this.scheduleRetry();
    };
  }

  handle(msg) {
    const d = msg.data || {};
    switch (msg.type) {
      case 'success_join':
        this.status('online', d.channel_name || '');
        this.system('connected — goodgame/' + this.channel);
        break;

      case 'message':
        if (String(d.channel_id) !== String(this.channelId)) return;
        this.onMessage(this.toMessage(d));
        break;

      case 'remove_message':
        this.onRemove({ ids: [this.key + ':' + d.message_id] });
        break;

      case 'ban':
      case 'ban_user':
        if (d.user_name) this.onRemove({ platform: 'goodgame', user: String(d.user_name).toLowerCase() });
        break;

      case 'error':
        this.status('error', d.errorMsg || d.message || 'chat error');
        break;

      default:
        break;
    }
  }

  toMessage(d) {
    const rights = Number(d.user_rights) || 0;
    const badges = [];
    if (Number(d.staff) > 0 || rights >= 40) badges.push({ kind: 'staff', label: 'ADMIN' });
    else if (rights >= 20) badges.push({ kind: 'broadcaster', label: 'HOST' });
    else if (rights >= 10) badges.push({ kind: 'moderator', label: 'MOD' });
    if (Number(d.premium) > 0) badges.push({ kind: 'premium', label: 'PREM' });

    return {
      id: this.key + ':' + d.message_id,
      platform: 'goodgame',
      channel: this.channel,
      userId: String(d.user_id),
      user: d.user_name,
      userLogin: String(d.user_name || '').toLowerCase(),
      color: U.ggColor(d.color, d.user_name),
      badges,
      parts: this.buildParts(String(d.text || '')),
      kind: 'chat',
      ts: d.timestamp ? Number(d.timestamp) * 1000 : Date.now(),
    };
  }

  /** GoodGame writes smiles as `:key:` inside the plain text. */
  buildParts(text) {
    const cfg = this.getConfig();
    if (!cfg.emotes || this.emoteMap.size === 0) return U.splitUrls(text);

    const parts = [];
    const re = /:([a-zA-Z0-9_\-]+):/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const hit = this.emoteMap.get(m[1].toLowerCase());
      if (!hit) continue;
      if (m.index > last) parts.push(...U.splitUrls(text.slice(last, m.index)));
      parts.push({ type: 'emote', url: hit.url, fallback: hit.fallback, name: m[1] });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(...U.splitUrls(text.slice(last)));
    return parts.length ? parts : U.splitUrls(text);
  }
}

/* ----------------------------------------------------------------- Twitch */

const TWITCH_BADGES = {
  broadcaster: { kind: 'broadcaster', label: 'HOST' },
  moderator: { kind: 'moderator', label: 'MOD' },
  vip: { kind: 'vip', label: 'VIP' },
  subscriber: { kind: 'subscriber', label: 'SUB' },
  founder: { kind: 'subscriber', label: 'SUB' },
  staff: { kind: 'staff', label: 'STAFF' },
  admin: { kind: 'staff', label: 'STAFF' },
  global_mod: { kind: 'staff', label: 'GMOD' },
  partner: { kind: 'premium', label: 'PTNR' },
};

function unescapeTag(v) {
  return String(v)
    .replace(/\\s/g, ' ')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\:/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseIrc(line) {
  let rest = line;
  const tags = {};

  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    for (const kv of rest.slice(1, sp).split(';')) {
      const eq = kv.indexOf('=');
      if (eq === -1) tags[kv] = '';
      else tags[kv.slice(0, eq)] = unescapeTag(kv.slice(eq + 1));
    }
    rest = rest.slice(sp + 1);
  }

  let prefix = '';
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }

  let trailing = null;
  const ti = rest.indexOf(' :');
  if (ti !== -1) {
    trailing = rest.slice(ti + 2);
    rest = rest.slice(0, ti);
  }

  const bits = rest.split(' ').filter(Boolean);
  const command = bits.shift() || '';
  const params = bits;
  if (trailing !== null) params.push(trailing);

  return { tags, prefix, command, params };
}

class TwitchSource extends BaseSource {
  constructor(opts) {
    super(opts);
    this.platform = 'twitch';
    this.channel = String(opts.channel || '').toLowerCase().replace(/^#/, '');
    this.roomId = null;
  }

  connect() {
    if (this.dead) return;
    this.closeSocket();
    this.status('connecting');

    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    this.ws = ws;
    this.buffer = '';

    ws.onopen = () => {
      this.attempt = 0;
      const nick = 'justinfan' + (10000 + Math.floor(Math.random() * 80000));
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send('NICK ' + nick);
      ws.send('JOIN #' + this.channel);

      clearInterval(this.keepalive);
      this.keepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('PING :overlay');
      }, 240000);
    };

    ws.onmessage = (ev) => {
      for (const line of String(ev.data).split('\r\n')) {
        if (line) this.handle(line);
      }
    };

    ws.onerror = () => this.status('error', 'socket error');

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.keepalive);
      this.status('offline');
      this.scheduleRetry();
    };
  }

  handle(line) {
    const { tags, prefix, command, params } = parseIrc(line);

    switch (command) {
      case 'PING':
        if (this.ws) this.ws.send('PONG :' + (params[params.length - 1] || 'tmi.twitch.tv'));
        return;

      case 'RECONNECT':
        this.status('connecting', 'server asked to reconnect');
        this.closeSocket();
        this.scheduleRetry();
        return;

      case '001':
        this.status('online');
        return;

      case 'NOTICE': {
        const text = params[params.length - 1] || '';
        if (/improperly formatted|no such|failed/i.test(text)) this.status('error', text);
        this.system(text);
        return;
      }

      case 'ROOMSTATE':
        if (tags['room-id'] && tags['room-id'] !== this.roomId) {
          this.roomId = tags['room-id'];
          this.status('online');
          this.system('connected — twitch/' + this.channel);
          this.loadEmotes();
        }
        return;

      case 'CLEARCHAT': {
        const target = params[params.length - 1];
        if (target && !target.startsWith('#')) {
          this.onRemove({ platform: 'twitch', user: target.toLowerCase() });
        } else {
          this.onRemove({ platform: 'twitch', channel: this.channel, all: true });
        }
        return;
      }

      case 'CLEARMSG':
        if (tags['target-msg-id']) this.onRemove({ ids: [this.key + ':' + tags['target-msg-id']] });
        return;

      case 'USERNOTICE': {
        const note = tags['system-msg'] || '';
        if (note) this.system(note, 'event');
        return;
      }

      case 'PRIVMSG': {
        const text = params[params.length - 1] || '';
        const login = (prefix.split('!')[0] || tags['display-name'] || '').toLowerCase();
        this.onMessage(this.toMessage(tags, login, text));
        return;
      }

      default:
        return;
    }
  }

  loadEmotes() {
    if (this.getConfig().thirdPartyEmotes) {
      Emotes.twitchThirdParty(this.roomId)
        .then((map) => { this.emoteMap = map; })
        .catch((err) => console.warn('twitch 3rd-party emotes failed:', err.message));
    }
    Emotes.twitchBadges(this.roomId)
      .then((map) => { this.badgeMap = map; })
      .catch((err) => console.warn('twitch badges failed:', err.message));
  }

  toMessage(tags, login, rawText) {
    let text = rawText;
    let action = false;
    const am = /^ACTION (.*)$/.exec(text);
    if (am) { text = am[1]; action = true; }

    // badge-info carries the real sub tenure ("subscriber/27") for the tooltip.
    const info = new Map(
      String(tags['badge-info'] || '').split(',').filter(Boolean)
        .map((e) => [e.split('/')[0], e.split('/').slice(1).join('/')])
    );

    const badges = [];
    for (const entry of String(tags.badges || '').split(',')) {
      if (!entry) continue;
      const [set, version = '1'] = entry.split('/');
      const def = TWITCH_BADGES[set];
      const art = this.badgeMap.get(set + '/' + version);
      const months = info.get(set);
      badges.push({
        kind: def ? def.kind : 'generic',
        label: def ? def.label : set.replace(/[-_]/g, ' ').slice(0, 4).toUpperCase(),
        url: art ? art.url : null,
        title: (art ? art.title : set) + (months ? ` (${months})` : ''),
      });
      if (badges.length >= 8) break;
    }

    return {
      id: this.key + ':' + (tags.id || Date.now() + ':' + Math.random()),
      platform: 'twitch',
      channel: this.channel,
      userId: tags['user-id'] || '',
      user: tags['display-name'] || login,
      userLogin: login,
      color: tags.color
        ? U.readableColor(tags.color, login, this.getConfig().exactColors)
        : U.nickColor(login),
      badges,
      parts: this.buildParts(text, tags.emotes),
      action,
      kind: 'chat',
      ts: tags['tmi-sent-ts'] ? Number(tags['tmi-sent-ts']) : Date.now(),
    };
  }

  /**
   * Native Twitch emotes arrive as code-point ranges in the `emotes` tag, so the
   * text has to be indexed by code point (Array.from), not by UTF-16 unit.
   * Anything left over is scanned word-by-word against the 7TV/BTTV/FFZ map.
   */
  buildParts(text, emotesTag) {
    const cfg = this.getConfig();
    if (!cfg.emotes) return U.splitUrls(text);

    const chars = Array.from(text);
    const marks = new Array(chars.length).fill(null);

    if (emotesTag) {
      for (const chunk of emotesTag.split('/')) {
        const sep = chunk.indexOf(':');
        if (sep === -1) continue;
        const id = chunk.slice(0, sep);
        for (const range of chunk.slice(sep + 1).split(',')) {
          const [s, e] = range.split('-').map(Number);
          if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e >= chars.length) continue;
          marks[s] = { id, end: e };
        }
      }
    }

    const parts = [];
    let buf = '';
    const flush = () => {
      if (!buf) return;
      parts.push(...this.scanWords(buf));
      buf = '';
    };

    for (let i = 0; i < chars.length; i++) {
      const mark = marks[i];
      if (mark) {
        flush();
        parts.push({
          type: 'emote',
          url: Emotes.twitchNativeUrl(mark.id),
          name: chars.slice(i, mark.end + 1).join(''),
        });
        i = mark.end;
      } else {
        buf += chars[i];
      }
    }
    flush();
    return parts;
  }

  scanWords(text) {
    const cfg = this.getConfig();
    if (!cfg.thirdPartyEmotes || this.emoteMap.size === 0) return U.splitUrls(text);

    const parts = [];
    let pending = '';
    for (const token of text.split(/(\s+)/)) {
      const hit = token.trim() ? this.emoteMap.get(token) : null;
      if (hit) {
        if (pending) { parts.push(...U.splitUrls(pending)); pending = ''; }
        parts.push({ type: 'emote', url: hit.url, name: token });
      } else {
        pending += token;
      }
    }
    if (pending) parts.push(...U.splitUrls(pending));
    return parts;
  }
}

window.Sources = { GoodGameSource, TwitchSource };
