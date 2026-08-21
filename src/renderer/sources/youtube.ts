import type { PlatformName } from '../../main/types.js';
import { nickColor, splitUrls, type MessagePart } from '../util.js';
import { BaseSource } from './base.js';
import {
  chatPageActions, chatPageUrl, chatStart, chatTarget, clientVersion, livePageUrl,
  parsePoll, pollBody, videoIdFromLivePage, YT_CHAT_POLL_URL, YT_POLL_MAX_MS, YT_POLL_MS,
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
 * `this.ws` simply stays null, and `send` already does nothing when it is.
 * `closeSocket` is not nothing, though: it is BaseSource saying "this
 * connection is over", which for a poller means the watchdog *and* the poll
 * loop — see the override below.
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
 * How many message ids are remembered, so a reconnect does not replay chat.
 *
 * Every connect re-reads the chat page, and the page carries the last few
 * minutes of chat inside it. Bounded rather than complete because this runs for
 * hours: a busy stream is thousands of messages an evening, and a repeat older
 * than this could not be a duplicate of anything still on screen — the feed
 * itself holds far fewer than this.
 */
export const YT_SEEN_MAX = 400;

/**
 * The badges the protocol names by icon rather than by artwork.
 *
 * YouTube publishes no badge API and sends no image for these three, only the
 * name — so they map onto the kinds the renderer already knows, exactly as
 * GoodGame's roles do: moderator and broadcaster get the bundled artwork, the
 * rest a text chip. Membership badges are the other kind and do carry their own
 * artwork; see ytBadges.
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
  /** Consecutive polls answered with a spent token; see tokenStale(). */
  private staleReloads = 0;
  /** Consecutive polls that never came back at all; see poll(). */
  private failures = 0;
  /**
   * Which poll loop is the current one.
   *
   * A request in flight belongs to the connection that asked for it. When that
   * connection is let go of — the watchdog gave up, the token went stale,
   * destroy() — the answer must not be allowed to arrive afterwards and start
   * everything up again.
   */
  private pollEpoch = 0;
  /** Message ids already rendered, oldest first; see remember(). */
  private readonly seen = new Set<string>();
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

    this.saidNotLive = false;
    this.followed = 0;
    this.failures = 0;
    this.pollMs = YT_POLL_MS;
    this.status('online');
    // Not on a stale-token retry: the chat never went away, so announcing it
    // again would be a connection log written over one continuous session —
    // and, in a loop, a feed of nothing else. tokenStale() has the other half.
    if (this.staleReloads === 0) this.system('connected — youtube/' + this.channel);
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
    this.staleReloads = 0;
    // Not `offline`: nothing is wrong, and the bar draws only what is wrong.
    // Most channels are not streaming most of the time, so painting this as a
    // failure would leave a permanent alert over the game for the ordinary
    // case — which is the one thing the bar is designed never to do.
    this.status('idle', 'not live');
    if (!this.saidNotLive) {
      this.saidNotLive = true;
      this.system(`not live — youtube/${this.channel}`);
    }
    this.clearWatchdog();
    this.clearTimeoutFn(this.retryTimer);
    this.retryTimer = this.setTimeoutFn(() => this.reconnect(), this.notLiveMs);
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

  /**
   * Arm the next poll, replacing whatever was pending.
   *
   * No guard against a destroyed source, because there is nothing left for one
   * to catch: every caller has already established that this poll loop is the
   * current one, and destroy() goes through stopPolling(), which both clears
   * the timer and makes any answer still in flight arrive too late to re-arm
   * anything. An unreachable guard is worse than none — it reads as a case
   * somebody has seen.
   */
  private pump(ms: number): void {
    this.clearTimeoutFn(this.pollTimer);
    this.pollTimer = this.setTimeoutFn(() => void this.poll(), ms);
  }

  private stopPolling(): void {
    this.clearTimeoutFn(this.pollTimer);
    this.pollTimer = null;
    this.busy = false;
    this.pollEpoch += 1;
  }

  /**
   * Let go of the transport — which here is a poll loop rather than a socket.
   *
   * BaseSource calls this wherever it means "this connection is over": the
   * watchdog giving up, and destroy(). A socket source has nothing left to do
   * afterwards, but a poller has a timer armed and possibly a request in
   * flight, and without this they outlive the announcement — messages arriving
   * after the feed has said the source is offline, and noteAlive() re-arming
   * the watchdog on a connection the app has already given up on.
   */
  protected override closeSocket(): void {
    this.stopPolling();
    super.closeSocket();
  }

  /** Whether an answer belongs to a poll loop that has since been let go of. */
  private outlived(epoch: number): boolean {
    return this.dead || epoch !== this.pollEpoch;
  }

  /**
   * Note a message id, and say whether it has not been seen before.
   *
   * The chat page carries the last few minutes of chat, so every reconnect
   * offers the feed a backlog it has probably already rendered. The renderer's
   * own de-dup only knows about messages still in the DOM, so anything faded or
   * trimmed would come back at the bottom of the feed with a timestamp minutes
   * old. Bounded; see YT_SEEN_MAX.
   */
  private remember(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > YT_SEEN_MAX) {
      this.seen.delete(this.seen.values().next().value as string);
    }
    return true;
  }

  async poll(): Promise<void> {
    if (this.dead || this.busy || !this.continuation) return;
    const epoch = this.pollEpoch;
    this.busy = true;
    let raw: unknown;
    try {
      raw = await this.httpPost(YT_CHAT_POLL_URL, pollBody(this.version, this.continuation));
    } catch {
      if (this.outlived(epoch)) return;
      // Silence, not death — say nothing and drop nothing. A poll that failed
      // is a blip until the watchdog has asked and been ignored, which is the
      // same judgement the sockets make about a quiet channel.
      //
      // It does slow down, though. The interval here is the one the *server*
      // asked for while it was healthy, and answering a 429 or a 500 at the
      // pace of a working chat is how a client earns a longer ban than the one
      // it already has. Capped at the same ceiling a server-supplied interval
      // is, so the watchdog still gets its say first.
      this.busy = false;
      this.failures += 1;
      this.pump(Math.min(YT_POLL_MAX_MS, this.pollMs * Math.pow(2, Math.min(this.failures, 4))));
      return;
    }
    if (this.outlived(epoch)) return;
    this.busy = false;
    this.failures = 0;

    const poll = parsePoll(raw);
    // The envelope is gone: there is nothing left to poll, so the stream ended.
    // A positive signal rather than silence, so it goes straight out through
    // the door every other disconnect uses instead of waiting on the watchdog.
    if (!poll) return this.streamGone();

    this.noteAlive();
    // Before the actions, not after: what the messages in this answer are
    // handed is the wait until the *next* one, which is the interval they have
    // to be let out across. Reading it afterwards paces every batch against
    // the interval of the batch before it.
    this.pollMs = poll.timeoutMs;
    this.handle(poll.actions);

    if (poll.stale) return this.tokenStale();
    if (!poll.continuation) return this.streamGone();

    // Answered *and* advancing, which is the only thing that proves this
    // connection works: a chat that cannot be followed resolves its pages
    // perfectly, so a page that loaded is not evidence and must not be what
    // zeroes the backoff.
    this.followed += 1;
    this.attempt = 0;
    if (this.staleReloads >= 2) this.system('connected — youtube/' + this.channel);
    this.staleReloads = 0;
    this.continuation = poll.continuation;
    this.pump(this.pollMs);
  }

  /**
   * The server answered with a reload wrapper: our place in the chat is spent.
   *
   * Once is ordinary. The token expired, the chat itself is fine, and the fix
   * is to pick the stream up again from the page — immediately, and without a
   * word, because nothing the user can see has gone away.
   *
   * Twice in a row is a different thing: the token just fetched came back spent
   * as well, so fetching again on the spot is a loop over two pages, one of
   * them over a megabyte, as fast as the network will answer — and a
   * "connected" line into the feed on every turn of it. That is a chat that
   * cannot be followed, which is a connection lost: it says so once and takes
   * the same backoff every other disconnect takes. The curve climbs because
   * only a poll that advances zeroes it.
   */
  private tokenStale(): void {
    this.stopPolling();
    this.staleReloads += 1;
    if (this.staleReloads === 1) {
      void this.connect();
      return;
    }
    this.status('offline', 'chat is not advancing');
    if (this.staleReloads === 2) this.system(`lost — youtube/${this.channel}`);
    this.scheduleRetry();
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
        const msg = this.toMessage(item);
        // The interval the server itself asked for, handed on so the feed can
        // let this batch out across it instead of in one frame. It is the
        // server's number and it moves, so nothing here assumes a value.
        if (this.remember(msg.id)) this.onMessage(msg, this.pollMs);
        continue;
      }
      const removed = dig(action, 'removeChatItemAction', 'targetItemId');
      if (removed) {
        this.onRemove({ ids: [this.key + ':' + str(removed)] });
        continue;
      }
      const banned = dig(action, 'removeChatItemByAuthorAction', 'externalChannelId');
      if (banned) {
        // By channel id, which is the only unique thing about a YouTube author.
        // Display names are freely reusable and copying a regular's name is
        // routine in a large chat, so removing by name would take the person
        // being impersonated down along with the impersonator — the same
        // mistake as a ban leaking across channels, which 1.3.0 already fixed.
        this.onRemove({ platform: 'youtube', channel: this.channel, userId: str(banned) });
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
