import type { PlatformName } from '../../main/types.js';
import { nickColor, readableColor, splitUrls, type MessagePart } from '../util.js';
import { BaseSource } from './base.js';
import { nickFromPrefix, parseIrc } from './irc.js';
import type { Badge, ChatMessage, SourceOptions } from './types.js';

/**
 * Twitch chat over anonymous IRC-over-WebSocket.
 *
 * No account, no OAuth: a `justinfan` nick is enough to read any public
 * channel, which is why this app never asks for credentials.
 */
export const TWITCH_WS_URL = 'wss://irc-ws.chat.twitch.tv:443';

/**
 * How long the socket may go completely silent before it is worth asking
 * whether anyone is still there.
 *
 * Twitch's own server PINGs roughly every five minutes and this client answers
 * PONG, so frames arrive on a channel where nobody is talking — four minutes of
 * nothing at all is already longer than the gap the server itself keeps to. The
 * probe sent at that point is the same `PING :overlay` this file has always
 * sent; what is new is that an answer is expected, and that any inbound frame
 * counts as one.
 */
export const KEEPALIVE_MS = 240000;

export const TWITCH_BADGES: Record<string, { kind: string; label: string }> = {
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

export const TWITCH_EMOTE_BASE = 'https://static-cdn.jtvnw.net/emoticons/v2/';

export function twitchEmoteUrl(id: string, base: string = TWITCH_EMOTE_BASE): string {
  return base + id + '/default/dark/2.0';
}

/** Turn the `badges` / `badge-info` tags into what the renderer draws. */
export function buildBadges(
  badgesTag: string,
  badgeInfoTag: string,
  art: Map<string, { url: string; title: string }>,
): Badge[] {
  const info = new Map(
    String(badgeInfoTag || '').split(',').filter(Boolean)
      .map((e) => [e.split('/')[0] as string, e.split('/').slice(1).join('/')] as const),
  );

  const badges: Badge[] = [];
  for (const entry of String(badgesTag || '').split(',')) {
    if (!entry) continue;
    const [set = '', version = '1'] = entry.split('/');
    const def = TWITCH_BADGES[set];
    const found = art.get(set + '/' + version);
    const months = info.get(set);
    badges.push({
      kind: def ? def.kind : 'generic',
      label: def ? def.label : set.replace(/[-_]/g, ' ').slice(0, 4).toUpperCase(),
      url: found ? found.url : null,
      title: (found ? found.title : set) + (months ? ` (${months})` : ''),
    });
    if (badges.length >= 8) break;
  }
  return badges;
}

export class TwitchSource extends BaseSource {
  readonly platform: PlatformName = 'twitch';
  roomId: string | null = null;
  protected readonly idleMs = KEEPALIVE_MS;
  private emoteBase: string;

  constructor(opts: SourceOptions) {
    super(opts);
    this.channel = String(opts.channel || '').toLowerCase().replace(/^#/, '');
    this.emoteBase = opts.emoteBase ?? TWITCH_EMOTE_BASE;
  }

  connect(): void {
    if (this.dead) return;
    this.closeSocket();
    this.status('connecting');

    const ws = this.createSocket(this.wsUrl ?? TWITCH_WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      const nick = 'justinfan' + (10000 + Math.floor(this.random() * 80000));
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send('NICK ' + nick);
      ws.send('JOIN #' + this.channel);
      // Start the liveness clock here rather than on the first frame: a server
      // that accepts the socket and then says nothing at all is exactly the
      // case worth catching.
      this.noteAlive();
    };

    ws.onmessage = (ev) => {
      this.noteAlive();
      for (const line of String(ev.data).split('\r\n')) {
        if (line) this.handle(line);
      }
    };

    ws.onerror = () => this.status('error', 'socket error');

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.status('offline');
      this.scheduleRetry();
    };
  }

  /** Twitch answers a client PING with a PONG, on any channel, immediately. */
  protected probe(): void {
    this.send('PING :overlay');
  }

  handle(line: string): void {
    const { tags, prefix, command, params } = parseIrc(line);

    switch (command) {
      case 'PING':
        this.send('PONG :' + (params[params.length - 1] ?? 'tmi.twitch.tv'));
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
        const text = params[params.length - 1] ?? '';
        if (/improperly formatted|no such|failed/i.test(text)) this.status('error', text);
        this.system(text);
        return;
      }

      case 'ROOMSTATE':
        if (tags['room-id'] && tags['room-id'] !== this.roomId) {
          this.roomId = tags['room-id'] as string;
          this.status('online');
          this.system('connected — twitch/' + this.channel);
          void this.loadAssets();
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
        const note = tags['system-msg'] ?? '';
        if (note) this.system(note, 'event');
        return;
      }

      case 'PRIVMSG': {
        const text = params[params.length - 1] ?? '';
        const login = nickFromPrefix(prefix) || String(tags['display-name'] ?? '').toLowerCase();
        this.onMessage(this.toMessage(tags, login, text));
        return;
      }

      default:
        return;
    }
  }

  /** Emote and badge catalogues for this channel; failures never stop the chat. */
  async loadAssets(): Promise<void> {
    const api = this.assets;
    const roomId = this.roomId;
    if (!api || !roomId) return;

    await Promise.all([
      this.getConfig().thirdPartyEmotes
        ? api.twitchThirdParty(roomId)
            .then((map) => { this.emoteMap = map; })
            .catch((err: Error) => this.onWarn('twitch 3rd-party emotes failed: ' + err.message))
        : Promise.resolve(),
      api.twitchBadges(roomId)
        .then((map) => { this.badgeMap = map; })
        .catch((err: Error) => this.onWarn('twitch badges failed: ' + err.message)),
    ]);
  }

  toMessage(tags: Record<string, string>, login: string, rawText: string): ChatMessage {
    let text = rawText;
    let action = false;
    // /me arrives wrapped in CTCP delimiters (\u0001ACTION \u2026\u0001). The
    // delimiters are optional here so the plain form is recognised too; matching
    // only "ACTION \u2026" would leave the control characters visible on screen.
    const am = /^\u0001?ACTION ([\s\S]*?)\u0001?$/.exec(text);
    if (am) { text = am[1] as string; action = true; }

    const color = tags['color']
      ? readableColor(tags['color'] as string, login, this.getConfig().exactColors)
      : nickColor(login);

    return {
      id: this.key + ':' + (tags['id'] ?? `${this.now()}:${this.random()}`),
      platform: 'twitch',
      channel: this.channel,
      userId: tags['user-id'] ?? '',
      user: tags['display-name'] || login,
      userLogin: login,
      color,
      badges: buildBadges(tags['badges'] ?? '', tags['badge-info'] ?? '', this.badgeMap),
      parts: this.buildParts(text, tags['emotes'] ?? ''),
      kind: 'chat',
      action,
      ts: tags['tmi-sent-ts'] ? Number(tags['tmi-sent-ts']) : this.now(),
    };
  }

  /**
   * Native Twitch emotes arrive as code-point ranges in the `emotes` tag, so the
   * text has to be indexed by code point (Array.from), not by UTF-16 unit — an
   * emoji earlier in the line shifts every later index otherwise.
   * Anything left over is scanned word-by-word against the 7TV/BTTV/FFZ map.
   */
  buildParts(text: string, emotesTag: string): MessagePart[] {
    if (!this.getConfig().emotes) return splitUrls(text);

    const chars = Array.from(text);
    const marks = new Array<{ id: string; end: number } | null>(chars.length).fill(null);

    if (emotesTag) {
      for (const chunk of emotesTag.split('/')) {
        const sep = chunk.indexOf(':');
        if (sep === -1) continue;
        const id = chunk.slice(0, sep);
        for (const range of chunk.slice(sep + 1).split(',')) {
          const [s, e] = range.split('-').map(Number);
          if (!Number.isInteger(s) || !Number.isInteger(e)) continue;
          if ((s as number) < 0 || (e as number) >= chars.length || (e as number) < (s as number)) continue;
          marks[s as number] = { id, end: e as number };
        }
      }
    }

    const parts: MessagePart[] = [];
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
          url: twitchEmoteUrl(mark.id, this.emoteBase),
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

  scanWords(text: string): MessagePart[] {
    if (!this.getConfig().thirdPartyEmotes || this.emoteMap.size === 0) return splitUrls(text);

    const parts: MessagePart[] = [];
    let pending = '';
    for (const token of text.split(/(\s+)/)) {
      const hit = token.trim() ? this.emoteMap.get(token) : undefined;
      if (hit) {
        if (pending) { parts.push(...splitUrls(pending)); pending = ''; }
        parts.push({ type: 'emote', url: hit.url, name: token });
      } else {
        pending += token;
      }
    }
    if (pending) parts.push(...splitUrls(pending));
    return parts;
  }
}
