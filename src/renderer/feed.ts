import type { Config } from '../main/types.js';
import type { ChatMessage, RemoveRequest } from './sources/types.js';
import { messagesToRemove, shouldDrop } from './view.js';

/**
 * What the feed holds and when it is written to the screen.
 *
 * The rule is that arrivals are *coalesced*: a message joins a queue and the
 * whole queue is built and inserted once, on the next frame. Nothing here
 * touches the DOM — the calls that do are injected — because the interesting
 * part is not the appending, it is everything that has to keep being true
 * about messages that have arrived but are not on screen yet.
 *
 * Why it is not one-at-a-time any more:
 *
 * Appending a message and then reading `scrollHeight` to follow it forces the
 * browser to lay the page out synchronously, before the next line can be
 * added. One per message is survivable on Twitch and GoodGame, which trickle a
 * message per frame down a socket. YouTube is a poll: one answer carries every
 * message since the last one, so a busy channel hands the renderer two or
 * three hundred at once, and that became three hundred forced layouts in a row
 * before the browser was allowed to paint anything at all. Measured on a real
 * Electron with a 300-message batch: 302 layouts, 300 separate writes into the
 * feed, and 180 elements built only to be deleted by the message cap in the
 * same breath.
 *
 * The queue is what makes the rest of this file necessary. A message that is
 * queued is a message that exists — a ban has to reach it, its lifetime is
 * already running, and the cap already counts it — but it has no element, so
 * none of that can be done by looking at the DOM.
 *
 * The second thing the queue makes possible is *pacing*, which is the other
 * half of the same problem. Coalescing fixed the cost of a poll; it did not
 * touch its rhythm. Measured against a fake channel answered at the interval
 * YouTube asks for, a busy chat wrote 9.6 messages into the feed in a single
 * frame — a 246px jump under the reader's eye — and then did nothing at all
 * for 1304ms, over and over. At thirty messages a second it was 883px in one
 * frame, which is more than a window height: lines appeared and were scrolled
 * past without ever being painted once. A socket has none of this, because a
 * socket hands over one message at a time. So a source that arrives in lumps
 * says how far apart its lumps are, and the queue is let out across that
 * interval instead of all at once.
 */

/**
 * How long after the fade is over the element is taken out.
 *
 * The transition has to have finished, or the message vanishes mid-fade; a
 * frame or two of slack costs nothing and is invisible.
 */
export const FADE_GRACE_MS = 60;

/**
 * How much of the interval between two arrivals a batch is spread over.
 *
 * Comfortably short of the whole interval, so the queue is always empty again
 * before the next answer lands and cannot grow across intervals. The headroom
 * also absorbs an answer that comes back early, which YouTube's does whenever
 * the server shortens the timeout it asks for.
 */
export const PACE_FRACTION = 0.7;

/**
 * The most a message is ever held back, whatever interval the source names.
 *
 * YouTube's advertised timeout is clamped to thirty seconds at the top end, and
 * spreading a handful of messages over twenty of them would be all latency and
 * no benefit — a channel that quiet has no rhythm to smooth. Chat that is
 * smooth but late is worse than chat that clumps, so the window is capped here
 * rather than left to whatever the server names.
 */
export const PACE_MAX_MS = 1000;

interface Entry<N, T> {
  id: string;
  msg: ChatMessage;
  /** null while the message is queued and has not been built yet. */
  node: N | null;
  timer: T | null;
}

/**
 * Everything the feed needs from the world outside it: the DOM calls, the
 * clock, and the frame it waits for. All injected, so the rules above can be
 * tested without a browser — which is the only way the queued-but-not-painted
 * states are reachable from a test at all.
 */
export interface FeedDeps<N, T> {
  /** Build a message's element. Called only for messages that will be shown. */
  build(msg: ChatMessage): N;
  /** Put the whole batch into the feed, in order, in one write. */
  insert(nodes: N[]): void;
  /** Take one element back out. */
  detach(node: N): void;
  /** Start an element fading, before it is detached. */
  fade(node: N): void;
  /** Ask to be called back on the next frame. */
  schedule(flush: () => void): void;
  /** A monotonic clock, in milliseconds. Only pacing reads it. */
  now(): number;
  /** Called once per flush, after the feed has been written to. */
  painted(): void;
  config(): Config;
  setTimer(run: () => void, ms: number): T;
  clearTimer(handle: T): void;
}

export class Feed<N, T> {
  /** Every message that exists, painted or not, in arrival order. */
  private readonly entries = new Map<string, Entry<N, T>>();
  /** Those with no element yet, in arrival order. */
  private queue: Entry<N, T>[] = [];
  private scheduled = false;
  /**
   * How far apart the arrivals of the source that last added are, or 0 for one
   * that arrives a message at a time.
   *
   * Set by every arrival, so the last one wins: a socket message landing in the
   * same frame as a poll's batch zeroes it and the whole queue goes out at
   * once. That is deliberate. Twitch and GoodGame trickle already, and holding
   * one of their messages behind somebody else's batch would be a regression
   * for the two sources this was never about — so an unpaced arrival is also
   * the signal to stop pacing. Where both are busy the feed is flowing on its
   * own anyway, which is the thing pacing exists to produce.
   */
  private paceMs = 0;
  /** The release schedule for the queue as it stood when it was last added to. */
  private pace: { start: number; window: number; total: number; done: number } | null = null;
  /**
   * Whether the cap threw any of the pending batch away.
   *
   * The tell that a batch is bigger than the screen, and so that pacing it is
   * pointless — see `due`. Set as the batch arrives and consumed by the flush
   * that decides what to do with it.
   */
  private capped = false;

  constructor(private readonly deps: FeedDeps<N, T>) {}

  /** How many messages the feed is holding, queued ones included. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * A message has arrived.
   *
   * `paceMs` is how long the source expects to wait before its next arrival —
   * for YouTube, the timeout the server itself asked for. A source that hands
   * messages over one at a time passes nothing, and nothing about its
   * behaviour changes.
   */
  add(msg: ChatMessage, paceMs = 0): void {
    const config = this.deps.config();
    if (this.entries.has(msg.id) || shouldDrop(msg, config)) return;

    const entry: Entry<N, T> = { id: msg.id, msg, node: null, timer: null };
    // Measured from arrival, which is what it has always been — arrival and
    // painting used to be the same moment. Anything else would hand a message
    // that queued behind a burst a longer life than the one in front of it,
    // and would leave the timers of a 300-message batch expiring in a fan
    // rather than together.
    if (config.messageLifetime > 0) {
      entry.timer = this.deps.setTimer(() => this.expire(entry), config.messageLifetime * 1000);
    }
    this.entries.set(msg.id, entry);
    this.queue.push(entry);

    // Anything queued beyond the cap can never be seen: the flush would delete
    // it in the same frame it was built in. Dropped here instead, so a burst
    // several times the cap builds only what fits — and so the queue stays
    // bounded even if frames stop coming, which is what an occluded window
    // does.
    for (const stale of this.queue.splice(0, this.queue.length - config.maxMessages)) {
      this.capped = true;
      this.forget(stale);
    }

    // Recomputed from scratch on the next flush, against whatever is queued by
    // then: an arrival mid-release is a new batch, and the leftovers of the old
    // one are simply part of it.
    this.paceMs = paceMs;
    this.pace = null;

    if (this.scheduled) return;
    this.scheduled = true;
    this.deps.schedule(() => this.flush());
  }

  /**
   * Decide how the queue standing right now should be let out, and how much of
   * it is due at `now`.
   *
   * Two batches are left alone. One message is not a clump — pacing it would
   * add latency to the case that already looks like a socket. And a batch that
   * fills the message cap replaces every line on screen whichever way it is
   * drawn, so spreading it turns the whole feed into a wipe that lasts most of
   * a second, at the price of a write per frame throughout. The cap has already
   * dropped everything beyond it in `add`; what is left goes out in one piece,
   * exactly as it did before. Having had to drop any of it is the tell, because
   * a moderator taking a few lines out of the same batch would otherwise leave
   * three hundred arrivals looking like a hundred and sixteen.
   */
  private due(now: number): number {
    const overflowed = this.capped;
    this.capped = false;
    if (this.pace === null && this.paceMs > 0) {
      const cap = this.deps.config().maxMessages;
      if (!overflowed && this.queue.length > 1 && this.queue.length < cap) {
        this.pace = {
          start: now,
          window: Math.min(this.paceMs * PACE_FRACTION, PACE_MAX_MS),
          total: this.queue.length,
          done: 0,
        };
      }
    }
    const pace = this.pace;
    if (pace === null) return this.queue.length;
    const elapsed = now - pace.start;
    // Out of time — whatever is left goes now. This is what bounds the delay:
    // a window that has run out releases the rest whether the frames came on
    // time or not.
    if (elapsed >= pace.window) return this.queue.length;
    // The nth message is due at n/total of the way through the window, so the
    // head of a batch is painted in the same frame it would have been anyway.
    // `done` can never run ahead of `want`: a release only ever takes what is
    // owed, and the window only ever moves forwards.
    const want = Math.floor((pace.total * elapsed) / pace.window) + 1;
    return Math.min(this.queue.length, want - pace.done);
  }

  /**
   * Write whatever is due into the feed, once.
   *
   * One `insert`, one trim, one call to `painted` — which is where the scroll
   * happens, and the read that forces the layout with it. For everything but a
   * paced batch, "due" is the whole queue and this is the one frame it takes.
   */
  private flush(): void {
    this.scheduled = false;
    const due = this.due(this.deps.now());
    // A paced frame with nothing due yet must not touch the feed at all: the
    // scroll read in `painted` is the forced layout this file exists to keep
    // down to one per write. Unpaced, an empty queue still goes through, which
    // is what a batch that was removed before it could be painted looks like.
    if (due > 0 || this.paceMs === 0) {
      const pending = this.queue.splice(0, due);
      if (this.pace !== null) this.pace.done += pending.length;
      const built: N[] = [];
      for (const entry of pending) {
        entry.node = this.deps.build(entry.msg);
        built.push(entry.node);
      }
      if (built.length > 0) this.deps.insert(built);
      this.trim();
      this.deps.painted();
    }
    // Only while something is still waiting, so nothing runs over an empty
    // queue.
    if (this.queue.length === 0) return;
    this.scheduled = true;
    this.deps.schedule(() => this.flush());
  }

  /**
   * A message's time is up. If it never made it onto the screen there is
   * nothing to fade — it simply never appears, which is the same thing the
   * user would have seen had it been painted and faded within the frame.
   */
  private expire(entry: Entry<N, T>): void {
    entry.timer = null;
    if (entry.node === null) {
      this.remove(entry.id);
      return;
    }
    this.deps.fade(entry.node);
    entry.timer = this.deps.setTimer(
      () => this.remove(entry.id),
      this.deps.config().fadeDuration * 1000 + FADE_GRACE_MS,
    );
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    // Still queued: it has to come out of the queue as well, or the flush
    // builds and shows a message that was already taken down. A timeout
    // arriving in the same batch as the message it removes is exactly this.
    if (entry.node === null) this.queue = this.queue.filter((e) => e !== entry);
    this.forget(entry);
  }

  /** Forget an entry that is already out of the queue. */
  private forget(entry: Entry<N, T>): void {
    if (entry.timer !== null) this.deps.clearTimer(entry.timer);
    if (entry.node !== null) this.deps.detach(entry.node);
    this.entries.delete(entry.id);
  }

  /**
   * Which messages a removal takes down, queued ones included.
   *
   * Matched against the messages themselves rather than against what the DOM
   * says about them: a queued message has no element to carry a `data-user`,
   * and a ban that could not reach it would leave it to be painted a frame
   * after the moderator took it down.
   */
  apply(req: RemoveRequest): void {
    const held = Array.from(this.entries.values(), (e) => ({
      id: e.id,
      platform: e.msg.platform,
      channel: e.msg.channel || '',
      user: e.msg.userLogin || '',
      userId: e.msg.userId || '',
    }));
    for (const id of messagesToRemove(req, held)) this.remove(id);
  }

  /** Hold the feed to `maxMessages`, oldest out first. */
  trim(): void {
    const excess = this.entries.size - this.deps.config().maxMessages;
    if (excess <= 0) return;
    for (const id of Array.from(this.entries.keys()).slice(0, excess)) this.remove(id);
  }

  clear(): void {
    for (const id of Array.from(this.entries.keys())) this.remove(id);
  }
}
