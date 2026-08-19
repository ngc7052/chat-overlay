import type { PlatformName } from '../../main/types.js';
import { nickColor, splitUrls, type MessagePart } from '../util.js';
import { BaseSource } from './base.js';
import {
  chatPageActions, chatPageUrl, chatStart, chatTarget, clientVersion, livePageUrl,
  parsePoll, pollBody, videoIdFromLivePage, YT_CHAT_POLL_URL, YT_POLL_MS,
} from './innertube.js';
import type { Badge, ChatMessage, SourceOptions } from './types.js';

/**
 * YouTube live chat, read anonymously through the endpoint the watch page uses.
 *
 * The one source here that is not a socket. The transport is a poll — YouTube
 * publishes no chat socket at any price — and the poll is what the whole shape
 * of this class follows from. What it is *not* is a different kind of source:
 * retries, status reporting, the lines the feed shows and the liveness watchdog
 * are all BaseSource's, unchanged, because none of them was ever about sockets.
 * `this.ws` simply stays null, and `send`/`closeSocket` already do nothing when
 * it is.
 *
 * The other difference is that a YouTube channel is not an address. It is a
 * stream that starts, ends and gets replaced, so "connected" here means "this
 * channel is live right now and here is its chat" — which is a state that comes
 * and goes on its own while the overlay sits open. See notLive().
 */

/**
 * How long the chat may produce nothing at all before it is worth asking.
 *
 * A poll answered is proof the connection works, whoever is talking, and the
 * server asks to be polled every ten seconds — so a minute of complete silence
 * is six polls that should have happened and did not. Same order as GoodGame's
 * counters broadcast, and for the same reason: it counts missed heartbeats, not
 * missed chat.
 */
export const YT_IDLE_MS = 60000;

/**
 * How long to wait before asking a channel that is not live whether it is yet.
 *
 * Deliberately far longer than the connection backoff, because this is not a
 * failure: most channels are offline most of the time, and that is the normal
 * state rather than something to recover from. It is also expensive — the page
 * that answers the question is over a megabyte — so a tighter loop would spend
 * real bandwidth to be told "no" all evening. Two minutes is late enough to be
 * cheap and early enough that a stream is caught near its start.
 */
export const YT_NOT_LIVE_MS = 120000;

/**
 * The badges the protocol names by icon rather than by artwork.
 *
 * YouTube publishes no badge API and sends no image for these three, only the
 * name — so they map onto the kinds the stylesheet already colours and render
 * as text chips, exactly as GoodGame's roles do. Membership badges are the
 * other kind and do carry their own artwork; see ytBadges.
 */
export const YT_BADGES: Record<string, { kind: string; label: string }> = {
  OWNER: { kind: 'broadcaster', label: 'HOST' },
  MODERATOR: { kind: 'moderator', label: 'MOD' },
  VERIFIED: { kind: 'premium', label: 'VER' },
};

function dig(value: unknown, ...path: string[]): unknown {
  let at = value;
  for (const key of path) {
    if (!at || typeof at !== 'object') return null;
    at = (at as Record<string, unknown>)[key];
  }
  return at ?? null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The largest variant YouTube offers; the overlay draws badges above 16px. */
function biggest(thumbnails: unknown): string | null {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
  const url = str(dig(thumbnails[thumbnails.length - 1], 'url'));
  return url || null;
}

/**
 * Author badges: a channel's own membership artwork, or a named role.
 *
 * Membership badges are per-channel and per-tier, like GoodGame's subscriber
 * icons, and arrive with their image — so they draw as artwork with the tier in
 * the tooltip. Roles arrive as a name and nothing else.
 */
export function ytBadges(raw: unknown): Badge[] {
  if (!Array.isArray(raw)) return [];
  const badges: Badge[] = [];
  for (const entry of raw) {
    const badge = dig(entry, 'liveChatAuthorBadgeRenderer');
    if (!badge) continue;
    const tooltip = str(dig(badge, 'tooltip'));
    const art = biggest(dig(badge, 'customThumbnail', 'thumbnails'));
    if (art) {
      badges.push({ kind: 'subscriber', label: 'MEM', url: art, title: tooltip || 'member' });
    } else {
      const icon = str(dig(badge, 'icon', 'iconType')).toUpperCase();
      const def = YT_BADGES[icon];
      badges.push({
        kind: def ? def.kind : 'generic',
        label: def ? def.label : icon.replace(/[-_]/g, ' ').slice(0, 4).trim().toUpperCase(),
        url: null,
        title: tooltip || icon.toLowerCase(),
      });
    }
    if (badges.length >= 8) break;
  }
  return badges;
}

/**
 * Message text, which arrives already split into runs.
 *
 * The one place YouTube is simpler than either other platform: emote artwork
 * comes down on the message itself, so there is no catalogue to fetch, cache or
 * fall back from. A membership emoji and a plain 😀 travel by the same route
 * and differ only in `isCustomEmoji`.
 */
export function ytParts(runs: unknown, emotes: boolean): MessagePart[] {
  if (!Array.isArray(runs)) return [];
  const parts: MessagePart[] = [];
  for (const run of runs) {
    const emoji = dig(run, 'emoji');
    if (!emoji) {
      parts.push(...splitUrls(str(dig(run, 'text'))));
      continue;
    }
    const shortcut = Array.isArray(dig(emoji, 'shortcuts')) ? str((dig(emoji, 'shortcuts') as unknown[])[0]) : '';
    const id = str(dig(emoji, 'emojiId'));
    const url = emotes ? biggest(dig(emoji, 'image', 'thumbnails')) : null;
    if (url) {
      parts.push({ type: 'emote', url, name: shortcut || id });
    } else {
      // With emotes off, a standard emoji is its own best text — the id *is*
      // the character. A custom one has no character, so its shortcut stands in.
      parts.push(...splitUrls(dig(emoji, 'isCustomEmoji') ? (shortcut || id) : (id || shortcut)));
    }
  }
  return parts;
}

export class YouTubeSource extends BaseSource {
  readonly platform: PlatformName = 'youtube';
  protected readonly idleMs = YT_IDLE_MS;

  /** The stream currently being read, once one has been found. */
  videoId: string | null = null;
  private continuation: string | null = null;
  private version = '';
  private pollTimer: unknown = null;
  private pollMs = YT_POLL_MS;
  /** One poll at a time: the watchdog's probe can land on top of a scheduled one. */
  private busy = false;
  /** Polls that followed a live chat since connecting; see streamGone(). */
  private followed = 0;
  /** So a channel that is offline all evening says so once, not every two minutes. */
  private saidNotLive = false;
  /**
   * Author channel id -> the login the feed rendered, kept as messages go past:
   * a ban names the author by channel id, and nothing on screen remembers it.
   */
  private readonly logins = new Map<string, string>();
  private readonly notLiveMs: number;
  private readonly httpText: NonNullable<SourceOptions['httpText']>;
  private readonly httpPost: NonNullable<SourceOptions['httpPost']>;

  constructor(opts: SourceOptions) {
    super(opts);
    this.httpText = opts.httpText ?? (async () => { throw new Error('no http available'); });
    this.httpPost = opts.httpPost ?? (async () => { throw new Error('no http available'); });
    // The e2e harness collapses every wait it can; a real install never sets it.
    this.notLiveMs = opts.watchdogMs ?? YT_NOT_LIVE_MS;
  }

  async connect(): Promise<void> {
    if (this.dead) return;
    this.stopPolling();
    // No socket to close, but this is what clears the watchdog.
    this.closeSocket();
    this.status('connecting');

    const target = chatTarget(this.channel);
    if (!target) {
      this.status('error', 'not a youtube channel or video');
      this.scheduleRetry();
      return;
    }

    let actions: unknown[] = [];
    try {
      const videoId = target.kind === 'video'
        ? target.value
        : videoIdFromLivePage(await this.httpText(livePageUrl(target.value)));
      if (this.dead) return;
      if (!videoId) return this.notLive();

      const html = await this.httpText(chatPageUrl(videoId));
      if (this.dead) return;
      const start = chatStart(html);
      if (start.kind === 'offline') return this.notLive();
      const version = clientVersion(html);
      if (start.kind === 'unreadable' || !version) throw new Error('chat page not understood');

      this.videoId = videoId;
      this.version = version;
      this.continuation = start.continuation;
      // The page arrives with the last few minutes of chat already in it, so
      // the feed starts with something rather than with a wait.
      actions = chatPageActions(html);
    } catch (err) {
      this.status('error', (err as Error).message);
      this.scheduleRetry();
      return;
    }

    this.attempt = 0;
    this.saidNotLive = false;
    this.followed = 0;
    this.pollMs = YT_POLL_MS;
    this.status('online');
    this.system('connected — youtube/' + this.channel);
    // Start the liveness clock here rather than on the first poll: a chat page
    // that resolves and then never answers a poll is exactly the case worth
    // catching.
    this.noteAlive();
    this.handle(actions);
    this.pump(0);
  }

  /**
   * The channel has no live chat: it is not streaming, or chat is off.
   *
   * Not a failure, so not the connection backoff — that curve exists to recover
   * from something broken, and nothing here is broken. It is also not silent:
   * the feed is the only surface an overlay has while locked, and "the channel
   * you added is not live" is the first thing a user wonders about an empty one.
   */
  private notLive(): void {
    this.videoId = null;
    this.continuation = null;
    this.status('offline', 'not live');
    if (!this.saidNotLive) {
      this.saidNotLive = true;
      this.system(`not live — youtube/${this.channel}`);
    }
    this.clearWatchdog();
    this.clearTimeoutFn(this.retryTimer);
    this.retryTimer = this.setTimeoutFn(() => void this.connect(), this.notLiveMs);
  }

  /**
   * Something the server is known to answer — which for a poller is the poll.
   *
   * Every successful poll is already the round trip the watchdog wants, so this
   * fires only when polls have stopped coming back at all, and asks for one
   * immediately rather than waiting out the rest of the interval.
   */
  protected probe(): void {
    this.pump(0);
  }

  private pump(ms: number): void {
    if (this.dead) return;
    this.clearTimeoutFn(this.pollTimer);
    this.pollTimer = this.setTimeoutFn(() => void this.poll(), ms);
  }

  private stopPolling(): void {
    this.clearTimeoutFn(this.pollTimer);
    this.pollTimer = null;
    this.busy = false;
  }

  async poll(): Promise<void> {
    if (this.dead || this.busy || !this.continuation) return;
    this.busy = true;
    let raw: unknown;
    try {
      raw = await this.httpPost(YT_CHAT_POLL_URL, pollBody(this.version, this.continuation));
    } catch {
      // Silence, not death — say nothing and drop nothing. A poll that failed
      // is a blip until the watchdog has asked and been ignored, which is the
      // same judgement the sockets make about a quiet channel.
      this.busy = false;
      this.pump(this.pollMs);
      return;
    }
    this.busy = false;
    if (this.dead) return;

    const poll = parsePoll(raw);
    // The envelope is gone: there is nothing left to poll, so the stream ended.
    // A positive signal rather than silence, so it goes straight out through
    // the door every other disconnect uses instead of waiting on the watchdog.
    if (!poll) return this.streamGone();

    this.noteAlive();
    this.handle(poll.actions);
    this.pollMs = poll.timeoutMs;
    if (poll.continuation && !poll.stale) this.followed += 1;

    if (poll.stale) {
      // The token expired — the chat is fine, our place in it is not. Pick the
      // stream up again from the page rather than poll a token that is spent.
      this.stopPolling();
      void this.connect();
      return;
    }
    if (!poll.continuation) return this.streamGone();
    this.continuation = poll.continuation;
    this.pump(this.pollMs);
  }

  /**
   * There is nothing left to poll.
   *
   * Which of two things that means depends on whether there ever was a chat
   * here. Having followed one and lost it is a connection going away, and gets
   * the line and the backoff every other disconnect gets — a 24/7 channel rolls
   * one stream into the next, and that is worth catching quickly.
   *
   * Finding the chat already over on the very first poll is not. It happens
   * because YouTube's channel page goes on advertising a stream whose chat has
   * closed, so resolving it again immediately succeeds and immediately fails —
   * a loop that re-downloads a megabyte-and-a-bit every second or two, forever,
   * and never says anything. There was no chat to lose, so this is the ordinary
   * "not live" state and takes the slow cadence.
   */
  private streamGone(): void {
    this.stopPolling();
    this.continuation = null;
    this.videoId = null;
    if (this.followed === 0) return this.notLive();
    this.socketGone();
  }

  handle(actions: unknown[]): void {
    for (const action of actions) {
      const item = dig(action, 'addChatItemAction', 'item', 'liveChatTextMessageRenderer');
      if (item) {
        this.onMessage(this.toMessage(item));
        continue;
      }
      const removed = dig(action, 'removeChatItemAction', 'targetItemId');
      if (removed) {
        this.onRemove({ ids: [this.key + ':' + str(removed)] });
        continue;
      }
      const banned = dig(action, 'removeChatItemByAuthorAction', 'externalChannelId');
      if (banned) {
        this.onRemove({ platform: 'youtube', channel: this.channel, user: this.logins.get(str(banned)) ?? '' });
      }
      // Anything else — a superchat, a membership gift, a renderer YouTube
      // introduced this morning — is skipped in silence. Switching on the full
      // set would turn every new type into a chat that stops rather than a
      // message that does not appear, and YouTube is mid-migration from
      // `…Renderer` to `…ViewModel` names across exactly these types.
    }
  }


  toMessage(item: unknown): ChatMessage {
    const name = str(dig(item, 'authorName', 'simpleText'));
    // Display names arrive with the handle's leading @; the login is what the
    // ignore list and the ban rules compare against.
    const login = name.replace(/^@/, '').toLowerCase();
    const channelId = str(dig(item, 'authorExternalChannelId'));
    if (channelId && login) this.logins.set(channelId, login);
    const sentUsec = Number(dig(item, 'timestampUsec'));

    return {
      id: this.key + ':' + (str(dig(item, 'id')) || `${this.now()}:${this.random()}`),
      platform: 'youtube',
      channel: this.channel,
      userId: channelId,
      user: name,
      userLogin: login,
      // YouTube carries no colour of its own, so every name is the shared hash.
      color: nickColor(login || name),
      badges: ytBadges(dig(item, 'authorBadges')),
      parts: ytParts(dig(item, 'message', 'runs'), this.getConfig().emotes),
      kind: 'chat',
      ts: Number.isFinite(sentUsec) && sentUsec > 0 ? Math.round(sentUsec / 1000) : this.now(),
    };
  }

  override destroy(): void {
    this.stopPolling();
    super.destroy();
  }
}
