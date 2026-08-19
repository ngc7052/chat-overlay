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

/**
 * GoodGame sends an icon name per message; these are the files behind them,
 * read off the site's own stylesheet. They are white monochrome SVGs, which is
 * exactly what an overlay on a dark background wants.
 *
 * Unlike Twitch, GoodGame publishes no badge API — the protocol carries only
 * the name, so this mapping is the contract.
 */
export const GG_ICON_BASE = 'https://static.goodgame.ru/images/chat-svg-icons/';

export const GG_ICONS: Record<string, string> = {
  android: 'Android24px', cherry: 'Cherry24px', coin: 'Donut24px', crown: 'Crown24px',
  cup: 'Cup24px', diamond: 'Dimond24px', eagle: 'Eagle24px', fire: 'Fire24px',
  helper: 'Helper24px', 'invite-2': 'Invader24px', ios: 'Apple24px', lawyer: 'Lawyer24px',
  moderator: 'Sword24px', mushroom: 'Mushroom24px', phone: 'Phone24px',
  retroghost: 'RetroGhost24px', staff: 'Wrench24px', star: 'StarFull24px',
  tank: 'Tank24px', top1: 'Hero24px', undead: 'Skull24px', win: 'Win24px',
};

/** GoodGame+ subscribers get a badge for how many months they have held it. */
export const GG_PLUS_TIERS = [1, 3, 6, 12, 24, 48, 96];

/**
 * Channels can replace the generic premium star with their own artwork, one
 * image per subscription tier. This is what the site shows and why a real
 * GoodGame chat looks colourful where the shared icons are monochrome.
 *
 * The tier comes from `resubs[channel_id]` on the message itself.
 */
export const GG_CHANNEL_ICON_BASE = 'https://goodgame.ru/files/icons/';
export const GG_MAX_ICON_TIER = 7;

export function ggChannelIconUrl(
  channelId: unknown,
  resubs: unknown,
  base: string = GG_CHANNEL_ICON_BASE,
): string | null {
  const channel = String(channelId ?? '');
  if (!/^\d+$/.test(channel)) return null;
  const table = resubs && typeof resubs === 'object' ? (resubs as Record<string, unknown>) : {};
  const tier = Number(table[channel]) || 0;
  if (tier <= 0) return null;
  return `${base}${channel}-${Math.min(tier, GG_MAX_ICON_TIER)}-48.png`;
}

export function ggIconUrl(name: unknown, base: string = GG_ICON_BASE): string | null {
  const file = GG_ICONS[String(name ?? '').toLowerCase()];
  return file ? base + file + '.svg' : null;
}

export function ggPlusIconUrl(tier: unknown, base: string = GG_ICON_BASE): string | null {
  const n = Number(tier) || 0;
  if (n <= 0) return null;
  // Round down to the highest tier badge that exists. n >= 1 here, and the
  // lowest tier is 1, so there is always one to land on.
  let step = GG_PLUS_TIERS[0] as number;
  for (const tier of GG_PLUS_TIERS) if (n >= tier) step = tier;
  return `${base}gg-${step}-24px.svg`;
}

interface GgMessageData {
  channel_id?: unknown;
  user_id?: unknown;
  user_name?: unknown;
  user_rights?: unknown;
  premium?: unknown;
  staff?: unknown;
  color?: unknown;
  icon?: unknown;
  resubs?: unknown;
  gg_plus_tier?: unknown;
  message_id?: unknown;
  timestamp?: unknown;
  text?: unknown;
}

/**
 * Role comes from a numeric rights level, and the per-user icon comes from the
 * `icon` field — the same one the site draws. Roles keep a text chip because
 * the protocol sends no icon for them.
 */
export function ggBadges(
  d: GgMessageData,
  iconBase: string = GG_ICON_BASE,
  channelIconBase: string = GG_CHANNEL_ICON_BASE,
): Badge[] {
  const rights = Number(d.user_rights) || 0;
  const badges: Badge[] = [];
  const add = (kind: string, label: string) => badges.push({ kind, label, url: null, title: label });

  if (Number(d.staff) > 0 || rights >= 40) add('staff', 'ADMIN');
  else if (rights >= 20) add('broadcaster', 'HOST');
  else if (rights >= 10) add('moderator', 'MOD');

  // A channel's own subscriber artwork wins over the shared monochrome icon.
  const channelIcon = String(d.icon) === 'star'
    ? ggChannelIconUrl(d.channel_id, d.resubs, channelIconBase)
    : null;
  const icon = channelIcon ?? ggIconUrl(d.icon, iconBase);
  if (icon) {
    badges.push({
      kind: 'gg-icon',
      label: String(d.icon).toUpperCase().slice(0, 4),
      url: icon,
      title: channelIcon ? 'subscriber' : String(d.icon),
    });
  }

  const ggPlus = ggPlusIconUrl(d.gg_plus_tier, iconBase);
  if (ggPlus) {
    badges.push({
      kind: 'premium',
      label: 'GG+',
      url: ggPlus,
      title: `GoodGame+ ${Number(d.gg_plus_tier)} months`,
    });
  }

  // Premium with no icon of its own still deserves a marker.
  if (Number(d.premium) > 0 && !icon) add('premium', 'PREM');
  return badges;
}

export class GoodGameSource extends BaseSource {
  readonly platform: PlatformName = 'goodgame';
  channelId: string | null = null;
  private readonly iconBase: string;
  private readonly channelIconBase: string;

  constructor(opts: SourceOptions) {
    super(opts);
    this.iconBase = opts.iconBase ?? GG_ICON_BASE;
    this.channelIconBase = opts.channelIconBase ?? GG_CHANNEL_ICON_BASE;
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

    const ws = this.createSocket(this.wsUrl ?? GG_WS_URL);
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
          this.onRemove({
            platform: 'goodgame',
            channel: this.channel,
            user: String(d.user_name).toLowerCase(),
          });
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
      badges: ggBadges(d, this.iconBase, this.channelIconBase),
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
