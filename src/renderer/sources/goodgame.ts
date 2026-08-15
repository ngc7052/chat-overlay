import type { PlatformName } from '../../main/types.js';
import { ggColor, splitUrls, type MessagePart } from '../util.js';
import { BaseSource } from './base.js';
import type { Badge, ChatMessage, SourceOptions } from './types.js';

/**
 * GoodGame chat over their JSON WebSocket protocol.
 *
 * Anonymous, like Twitch: `join` with a numeric channel id and messages start
 * arriving. The trailing slash on the URL is required — without it the server
 * answers 301 and the socket never opens.
 */
export const GG_WS_URL = 'wss://chat.goodgame.ru/chat2/';

export function channelStatusUrl(channel: string): string {
  return 'https://goodgame.ru/api/getchannelstatus?fmt=json&id=' + encodeURIComponent(channel);
}

interface GgMessageData {
  channel_id?: unknown;
  user_id?: unknown;
  user_name?: unknown;
  user_rights?: unknown;
  premium?: unknown;
  staff?: unknown;
  color?: unknown;
  message_id?: unknown;
  timestamp?: unknown;
  text?: unknown;
}

/** GoodGame expresses roles as a numeric rights level rather than badges. */
export function ggBadges(d: GgMessageData): Badge[] {
  const rights = Number(d.user_rights) || 0;
  const badges: Badge[] = [];
  const add = (kind: string, label: string) => badges.push({ kind, label, url: null, title: label });

  if (Number(d.staff) > 0 || rights >= 40) add('staff', 'ADMIN');
  else if (rights >= 20) add('broadcaster', 'HOST');
  else if (rights >= 10) add('moderator', 'MOD');
  if (Number(d.premium) > 0) add('premium', 'PREM');
  return badges;
}

export class GoodGameSource extends BaseSource {
  readonly platform: PlatformName = 'goodgame';
  channelId: string | null = null;

  constructor(opts: SourceOptions) {
    super(opts);
  }

  /** A channel name has to become the numeric id the chat server joins by. */
  async resolveChannelId(): Promise<string> {
    if (/^\d+$/.test(this.channel)) return this.channel;
    const data = await this.httpJson(channelStatusUrl(this.channel));
    const first = data && typeof data === 'object' ? Object.values(data as object)[0] : null;
    const streamId = first && typeof first === 'object'
      ? (first as { stream_id?: unknown }).stream_id
      : null;
    if (streamId === null || streamId === undefined || streamId === '') {
      throw new Error('channel not found');
    }
    return String(streamId);
  }

  async connect(): Promise<void> {
    if (this.dead) return;
    this.closeSocket();
    this.status('connecting');

    try {
      if (!this.channelId) this.channelId = await this.resolveChannelId();
    } catch (err) {
      this.status('error', 'channel lookup failed: ' + (err as Error).message);
      this.scheduleRetry();
      return;
    }
    if (this.dead) return;

    // Smiles are optional — a failure here must not stop the chat.
    if (this.assets) {
      this.assets.goodgameSmiles(this.channelId)
        .then((map) => { this.emoteMap = map; })
        .catch((err: Error) => this.onWarn('gg smiles failed: ' + err.message));
    }

    const ws = this.createSocket(GG_WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      ws.send(JSON.stringify({
        type: 'join',
        data: { channel_id: String(this.channelId), hidden: false },
      }));
    };

    ws.onmessage = (ev) => {
      let msg: unknown;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
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

  handle(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as { type?: unknown; data?: unknown };
    const d = (msg.data ?? {}) as Record<string, unknown> & GgMessageData;

    switch (msg.type) {
      case 'success_join':
        this.status('online', String(d['channel_name'] ?? ''));
        this.system('connected — goodgame/' + this.channel);
        return;

      case 'message':
        if (String(d.channel_id) !== String(this.channelId)) return;
        this.onMessage(this.toMessage(d));
        return;

      case 'remove_message':
        this.onRemove({ ids: [this.key + ':' + String(d['message_id']) ] });
        return;

      case 'ban':
      case 'ban_user':
        if (d.user_name) {
          this.onRemove({ platform: 'goodgame', user: String(d.user_name).toLowerCase() });
        }
        return;

      case 'error':
        this.status('error', String(d['errorMsg'] ?? d['message'] ?? 'chat error'));
        return;

      default:
        return;
    }
  }

  toMessage(d: GgMessageData): ChatMessage {
    return {
      id: this.key + ':' + String(d.message_id),
      platform: 'goodgame',
      channel: this.channel,
      userId: String(d.user_id ?? ''),
      user: String(d.user_name ?? ''),
      userLogin: String(d.user_name ?? '').toLowerCase(),
      color: ggColor(d.color, String(d.user_name ?? '')),
      badges: ggBadges(d),
      parts: this.buildParts(String(d.text ?? '')),
      kind: 'chat',
      ts: d.timestamp ? Number(d.timestamp) * 1000 : this.now(),
    };
  }

  /** GoodGame writes smiles as `:key:` inside the plain text. */
  buildParts(text: string): MessagePart[] {
    if (!this.getConfig().emotes || this.emoteMap.size === 0) return splitUrls(text);

    const parts: MessagePart[] = [];
    const re = /:([a-zA-Z0-9_-]+):/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const hit = this.emoteMap.get((m[1] as string).toLowerCase());
      if (!hit) continue;
      if (m.index > last) parts.push(...splitUrls(text.slice(last, m.index)));
      const part: MessagePart = { type: 'emote', url: hit.url, name: m[1] as string };
      if (hit.fallback) part.fallback = hit.fallback;
      parts.push(part);
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(...splitUrls(text.slice(last)));
    return parts.length ? parts : splitUrls(text);
  }
}
