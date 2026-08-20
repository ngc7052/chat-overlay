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
 */

/**
 * How long after the fade is over the element is taken out.
 *
 * The transition has to have finished, or the message vanishes mid-fade; a
 * frame or two of slack costs nothing and is invisible.
 */
export const FADE_GRACE_MS = 60;

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

  constructor(private readonly deps: FeedDeps<N, T>) {}

  /** How many messages the feed is holding, queued ones included. */
  get size(): number {
    return this.entries.size;
  }

  add(msg: ChatMessage): void {
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
      this.forget(stale);
    }

    if (this.scheduled) return;
    this.scheduled = true;
    this.deps.schedule(() => this.flush());
  }

  /**
   * Build the queue and write it to the feed, once.
   *
   * One `insert`, one trim, one call to `painted` — which is where the scroll
   * happens, and the read that forces the layout with it.
   */
  private flush(): void {
    this.scheduled = false;
    const pending = this.queue;
    this.queue = [];
    const built: N[] = [];
    for (const entry of pending) {
      entry.node = this.deps.build(entry.msg);
      built.push(entry.node);
    }
    if (built.length > 0) this.deps.insert(built);
    this.trim();
    this.deps.painted();
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
