import { describe, expect, it } from 'vitest';
import { normaliseConfig } from '../../src/main/config.js';
import type { Config } from '../../src/main/types.js';
import { Feed, FADE_GRACE_MS, type FeedDeps } from '../../src/renderer/feed.js';
import type { ChatMessage } from '../../src/renderer/sources/types.js';

/**
 * The feed's whole point is the window between a message arriving and a
 * message being painted, which does not exist in the DOM at all. So the harness
 * below is a fake screen: a list of the elements that are actually in the feed,
 * plus a frame and a clock that only move when a test says so.
 *
 * `flush()` is what a frame is. Nothing reaches the screen without one, which
 * is exactly the condition every rule here has to survive.
 */

interface Node { id: string; fading: boolean }

interface Screen {
  feed: Feed<Node, number>;
  /** What is on screen, in order. */
  shown(): string[];
  /** Run the frame the feed asked for, if it asked for one. */
  frame(): boolean;
  /** Advance the clock, firing anything due. */
  tick(ms: number): void;
  /** How many timers are still outstanding. */
  timersLeft(): number;
  /** One `insert` call per entry: how many nodes went in, in one write. */
  writes: number[];
  builds: string[];
  paints: number;
}

function screen(over: Partial<Config> = {}): Screen {
  const config = normaliseConfig({ maxMessages: 10, ...over });
  let nodes: Node[] = [];
  let pendingFrame: (() => void) | null = null;
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const state = { writes: [] as number[], builds: [] as string[], paints: 0 };

  const deps: FeedDeps<Node, number> = {
    build: (msg) => {
      state.builds.push(msg.id);
      return { id: msg.id, fading: false };
    },
    insert: (batch) => {
      state.writes.push(batch.length);
      nodes = nodes.concat(batch);
    },
    detach: (node) => { nodes = nodes.filter((n) => n !== node); },
    fade: (node) => { node.fading = true; },
    schedule: (flush) => { pendingFrame = flush; },
    now: () => now,
    painted: () => { state.paints += 1; },
    config: () => config,
    setTimer: (run, ms) => {
      const handle = nextTimer++;
      timers.set(handle, { at: now + ms, run });
      return handle;
    },
    clearTimer: (handle) => { timers.delete(handle); },
  };

  return {
    feed: new Feed(deps),
    shown: () => nodes.map((n) => n.id),
    frame: () => {
      const run = pendingFrame;
      pendingFrame = null;
      if (run) run();
      return run !== null;
    },
    tick: (ms) => {
      now += ms;
      for (const [handle, timer] of Array.from(timers)) {
        if (timer.at > now) continue;
        timers.delete(handle);
        timer.run();
      }
    },
    timersLeft: () => timers.size,
    get writes() { return state.writes; },
    get builds() { return state.builds; },
    get paints() { return state.paints; },
  };
}

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  platform: 'twitch',
  channel: 'halcyon_tv',
  user: 'Nero',
  userLogin: 'nero',
  color: '#fff',
  badges: [],
  parts: [{ type: 'text', value: 'hello' }],
  kind: 'chat',
  ts: 0,
  ...over,
});

/** A batch, as a poll delivers one: all of it before any frame happens. */
const burst = (feed: Feed<Node, number>, count: number, over: (i: number) => Partial<ChatMessage> = () => ({})): void => {
  for (let i = 0; i < count; i++) feed.add(message({ id: 'b' + i, ...over(i) }));
};

describe('coalescing', () => {
  it('shows nothing until the frame comes', () => {
    const s = screen();
    s.feed.add(message());
    expect(s.shown()).toEqual([]);
    s.frame();
    expect(s.shown()).toEqual(['m1']);
  });

  it('writes a whole batch into the feed in one go', () => {
    const s = screen({ maxMessages: 400 });
    burst(s.feed, 200);
    s.frame();
    expect(s.writes).toEqual([200]);
    expect(s.paints).toBe(1);
  });

  it('asks for one frame however many messages arrive', () => {
    const s = screen({ maxMessages: 400 });
    burst(s.feed, 50);
    expect(s.frame()).toBe(true);
    // Nothing new since, so nothing was scheduled.
    expect(s.frame()).toBe(false);
  });

  it('keeps arrival order across sources', () => {
    const s = screen();
    s.feed.add(message({ id: 'tw', platform: 'twitch' }));
    s.feed.add(message({ id: 'yt', platform: 'youtube' }));
    s.feed.add(message({ id: 'gg', platform: 'goodgame' }));
    s.frame();
    s.feed.add(message({ id: 'tw2', platform: 'twitch' }));
    s.frame();
    expect(s.shown()).toEqual(['tw', 'yt', 'gg', 'tw2']);
  });

  it('ignores a message it is already holding, painted or not', () => {
    const s = screen();
    s.feed.add(message({ id: 'dup' }));
    s.feed.add(message({ id: 'dup' }));
    s.frame();
    s.feed.add(message({ id: 'dup' }));
    s.frame();
    expect(s.shown()).toEqual(['dup']);
  });

  it('applies the filters on arrival, not on paint', () => {
    const s = screen({ ignoreList: ['nero'] });
    s.feed.add(message());
    expect(s.frame()).toBe(false);
    expect(s.shown()).toEqual([]);
  });

  it('paints nothing when every queued message went away first', () => {
    const s = screen();
    s.feed.add(message({ id: 'gone' }));
    s.feed.remove('gone');
    s.frame();
    expect(s.writes).toEqual([]);
    expect(s.paints).toBe(1);
  });
});

describe('the message cap', () => {
  it('holds exactly, and never builds what it is about to delete', () => {
    const s = screen({ maxMessages: 10 });
    burst(s.feed, 200);
    s.frame();
    expect(s.shown()).toHaveLength(10);
    expect(s.builds).toHaveLength(10);
    // The newest ten, not the oldest.
    expect(s.shown()).toEqual(['b190', 'b191', 'b192', 'b193', 'b194',
      'b195', 'b196', 'b197', 'b198', 'b199']);
  });

  it('trims what is already on screen to make room for a batch', () => {
    const s = screen({ maxMessages: 10 });
    burst(s.feed, 6);
    s.frame();
    for (let i = 0; i < 6; i++) s.feed.add(message({ id: 'later' + i }));
    s.frame();
    expect(s.shown()).toEqual([
      'b2', 'b3', 'b4', 'b5',
      'later0', 'later1', 'later2', 'later3', 'later4', 'later5',
    ]);
  });

  it('trims on demand when the setting is turned down', () => {
    const s = screen({ maxMessages: 10 });
    burst(s.feed, 10);
    s.frame();
    s.feed.trim();
    expect(s.shown()).toHaveLength(10);
  });
});

describe('removals', () => {
  it('takes down a message that is on screen', () => {
    const s = screen();
    s.feed.add(message({ id: 'a' }));
    s.feed.add(message({ id: 'b' }));
    s.frame();
    s.feed.apply({ ids: ['a'] });
    expect(s.shown()).toEqual(['b']);
  });

  it('takes down a message that is still queued, so it is never painted', () => {
    const s = screen();
    s.feed.add(message({ id: 'a' }));
    s.feed.add(message({ id: 'b' }));
    s.feed.apply({ ids: ['a'] });
    s.frame();
    expect(s.builds).toEqual(['b']);
    expect(s.shown()).toEqual(['b']);
  });

  it('bans an author across a batch it arrived in', () => {
    const s = screen({ maxMessages: 400 });
    burst(s.feed, 20, (i) => (i % 5 === 0
      ? { userId: 'UCtroll', userLogin: 'troll' }
      : { userId: 'UCok' + i }));
    s.feed.apply({ platform: 'twitch', channel: 'halcyon_tv', userId: 'UCtroll' });
    s.frame();
    expect(s.shown()).toHaveLength(16);
    expect(s.builds).toHaveLength(16);
  });

  it('leaves the feed\'s own system lines out of a channel clear', () => {
    const s = screen();
    s.feed.add(message({ id: 'sys', kind: 'system', channel: '', userLogin: '', user: '' }));
    s.feed.add(message({ id: 'chat' }));
    s.frame();
    s.feed.apply({ platform: 'twitch', channel: 'halcyon_tv', all: true });
    // A system line belongs to no channel, so no channel's moderation reaches it.
    expect(s.shown()).toEqual(['sys']);
  });

  it('shrugs at a removal for something it does not have', () => {
    const s = screen();
    s.feed.apply({ ids: ['never-seen'] });
    expect(s.shown()).toEqual([]);
  });

  it('clears everything, queued and painted alike', () => {
    const s = screen();
    s.feed.add(message({ id: 'shown' }));
    s.frame();
    s.feed.add(message({ id: 'queued' }));
    s.feed.clear();
    expect(s.feed.size).toBe(0);
    s.frame();
    expect(s.shown()).toEqual([]);
    expect(s.builds).toEqual(['shown']);
  });
});

describe('message lifetime', () => {
  it('fades a painted message and then takes it out', () => {
    const s = screen({ messageLifetime: 5, fadeDuration: 1 });
    s.feed.add(message({ id: 'a' }));
    s.frame();
    s.tick(5000);
    expect(s.shown()).toEqual(['a']);
    s.tick(1000 + FADE_GRACE_MS);
    expect(s.shown()).toEqual([]);
  });

  it('runs the clock from arrival, so a batch expires together', () => {
    const s = screen({ maxMessages: 400, messageLifetime: 5, fadeDuration: 1 });
    burst(s.feed, 30);
    // Two seconds of it spent queued behind the rest of the batch. That time
    // still counts: the last message of a burst must not outlive the first.
    s.tick(2000);
    s.frame();
    s.tick(3000);
    expect(s.shown()).toHaveLength(30);
    s.tick(1000 + FADE_GRACE_MS);
    expect(s.shown()).toEqual([]);
  });

  it('drops a message that expires before it is ever painted', () => {
    const s = screen({ messageLifetime: 5, fadeDuration: 1 });
    s.feed.add(message({ id: 'brief' }));
    s.tick(5000);
    s.frame();
    expect(s.builds).toEqual([]);
    expect(s.shown()).toEqual([]);
  });

  it('stops the clock on a message the cap dropped before it was painted', () => {
    const s = screen({ maxMessages: 10, messageLifetime: 5, fadeDuration: 1 });
    burst(s.feed, 200);
    // 200 arrived, 190 were dropped before the frame, and 190 timers went with
    // them. Left running, a burst on a busy channel would leave thousands of
    // them ticking for messages that were never on screen.
    expect(s.timersLeft()).toBe(10);
    s.frame();
    s.tick(5000);
    s.tick(1000 + FADE_GRACE_MS);
    expect(s.shown()).toEqual([]);
    expect(s.timersLeft()).toBe(0);
    expect(s.builds).toHaveLength(10);
  });

  it('leaves messages alone when there is no lifetime set', () => {
    const s = screen({ messageLifetime: 0 });
    s.feed.add(message({ id: 'a' }));
    s.frame();
    s.tick(600000);
    expect(s.shown()).toEqual(['a']);
  });

  it('stops a fade half-way if the message is removed first', () => {
    const s = screen({ messageLifetime: 5, fadeDuration: 1 });
    s.feed.add(message({ id: 'a' }));
    s.frame();
    s.tick(5000);
    s.feed.remove('a');
    s.tick(10000);
    expect(s.shown()).toEqual([]);
  });
});

/**
 * A poll's arrivals, and what the feed does with the interval it names.
 *
 * The measurements these exist to hold: against a channel answered every
 * 1300ms, a chat running at eight messages a second used to write 9.6 of them
 * into the feed in one frame — a 246px jump — and then nothing for 1304ms. At
 * thirty a second it was 883px, more than a window height, so lines were
 * scrolled past without ever being painted. Paced, both are one message and
 * 25px per write, 84ms and 20ms apart.
 */
describe('pacing what a poll delivers', () => {
  /** A poll's answer: `count` messages at once, naming the interval to the next. */
  const poll = (
    feed: Feed<Node, number>,
    count: number,
    paceMs: number,
    over: (i: number) => Partial<ChatMessage> = () => ({}),
  ): void => {
    for (let i = 0; i < count; i++) {
      feed.add(message({ id: 'p' + i, platform: 'youtube', ...over(i) }), paceMs);
    }
  };

  /** Frames, as a display produces them: the clock moves and then one runs. */
  const frames = (s: Screen, count: number, ms = 16): void => {
    for (let i = 0; i < count; i++) { s.tick(ms); s.frame(); }
  };

  it('lets a batch out one message at a time instead of in a single write', () => {
    const s = screen({ maxMessages: 100 });
    poll(s.feed, 10, 1000);
    // The head goes out in the frame it would have had anyway — pacing costs
    // the first message of a batch nothing.
    s.frame();
    expect(s.writes).toEqual([1]);
    expect(s.shown()).toEqual(['p0']);

    frames(s, 60);
    expect(s.shown()).toHaveLength(10);
    // Ten writes of one, which is what a socket looks like.
    expect(s.writes).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('spreads them over the interval rather than over the next few frames', () => {
    const s = screen({ maxMessages: 100 });
    poll(s.feed, 10, 1000);
    s.frame();
    // A tenth of the way through the 700ms window is one more message, not the
    // other nine — the release follows the clock, not the frame rate.
    frames(s, 1, 70);
    expect(s.shown()).toEqual(['p0', 'p1']);
    // Half way, half the batch — plus the head, which went out at once.
    frames(s, 7, 40);
    expect(s.shown()).toHaveLength(6);
    frames(s, 8, 40);
    expect(s.shown()).toHaveLength(10);
  });

  it('empties the queue well before the next answer is due', () => {
    const s = screen({ maxMessages: 100 });
    poll(s.feed, 20, 1000);
    // The interval is 1000ms and the window 700ms, so the queue is empty with
    // 300ms to spare — a batch can never be still going out when the next
    // one lands, which is what would let the queue grow without bound.
    frames(s, 44);
    expect(s.shown()).toHaveLength(20);
    expect(s.frame()).toBe(false);
  });

  it('caps how long a message is ever held back, whatever interval is named', () => {
    const s = screen({ maxMessages: 100 });
    // YouTube's advertised timeout goes up to thirty seconds. 70% of that would
    // be twenty-one, which is not smoothing, it is a delay.
    poll(s.feed, 5, 30000);
    frames(s, 20, 50);
    expect(s.shown()).toHaveLength(5);
  });

  it('releases the rest at once if the window runs out', () => {
    const s = screen({ maxMessages: 100 });
    poll(s.feed, 10, 1000);
    s.frame();
    // An occluded window, a long task, a frame that simply did not come: the
    // deadline is what bounds the delay, not the supply of frames.
    s.tick(5000);
    s.frame();
    expect(s.shown()).toHaveLength(10);
    expect(s.writes).toEqual([1, 9]);
  });

  it('leaves a source that arrives one at a time alone', () => {
    const s = screen({ maxMessages: 100 });
    // No interval named, so nothing to smooth: a socket already trickles, and a
    // frame of delay added to one of its messages is a regression.
    for (let i = 0; i < 10; i++) s.feed.add(message({ id: 's' + i }));
    s.frame();
    expect(s.writes).toEqual([10]);
    expect(s.frame()).toBe(false);
  });

  it('stops pacing the moment a socket message joins the queue', () => {
    const s = screen({ maxMessages: 100 });
    poll(s.feed, 10, 1000);
    frames(s, 3);
    expect(s.shown()).toHaveLength(1);
    // Order is arrival order, so this one is behind the eight still waiting.
    // Rather than hold it there for the rest of the window, the whole queue
    // goes out — which is the behaviour that shipped before pacing existed.
    s.feed.add(message({ id: 'tw' }));
    s.tick(16);
    s.frame();
    expect(s.shown()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4',
      'p5', 'p6', 'p7', 'p8', 'p9', 'tw']);
    expect(s.frame()).toBe(false);
  });

  it('keeps arrival order across sources while a batch is going out', () => {
    const s = screen({ maxMessages: 100 });
    poll(s.feed, 4, 1000);
    frames(s, 2);
    // A second answer mid-release: the leftovers of the first are simply part
    // of the new batch, and stay in front of it.
    for (let i = 0; i < 3; i++) {
      s.feed.add(message({ id: 'q' + i, platform: 'youtube' }), 1000);
    }
    frames(s, 60);
    expect(s.shown()).toEqual(['p0', 'p1', 'p2', 'p3', 'q0', 'q1', 'q2']);
  });

  it('does not pace a single message', () => {
    const s = screen({ maxMessages: 100 });
    poll(s.feed, 1, 1000);
    s.frame();
    expect(s.shown()).toEqual(['p0']);
    expect(s.frame()).toBe(false);
  });

  it('does not pace a batch the cap had to cut down', () => {
    const s = screen({ maxMessages: 10 });
    // 200 against a cap of 10: 190 can never be seen, and the ten that can
    // replace every line on screen however they are drawn. Spreading that over
    // most of a second would be a wipe, and a write every frame throughout.
    poll(s.feed, 200, 1000);
    s.frame();
    expect(s.writes).toEqual([10]);
    expect(s.frame()).toBe(false);
  });

  it('still declines when a moderator thins that batch below the cap', () => {
    const s = screen({ maxMessages: 10 });
    poll(s.feed, 200, 1000, (i) => (i >= 195 ? { userId: 'UCtroll' } : { userId: 'UC' + i }));
    // Five of the surviving ten taken down inside the same answer. What is left
    // is under the cap, but 200 still arrived — having had to drop any of them
    // is the tell, not what happens to be queued when the frame comes.
    s.feed.apply({ platform: 'youtube', channel: 'halcyon_tv', userId: 'UCtroll' });
    s.frame();
    expect(s.writes).toEqual([5]);
    expect(s.frame()).toBe(false);
  });

  it('does not pace a batch that fills the cap exactly', () => {
    const s = screen({ maxMessages: 10 });
    poll(s.feed, 10, 1000);
    s.frame();
    expect(s.writes).toEqual([10]);
  });

  it('asks for no frame at all once the queue is empty', () => {
    const s = screen({ maxMessages: 100 });
    poll(s.feed, 5, 1000);
    frames(s, 44);
    expect(s.shown()).toHaveLength(5);
    // Nothing is left to release, so nothing keeps running over an empty queue.
    expect(s.frame()).toBe(false);
    expect(s.timersLeft()).toBe(0);
  });

  it('takes a ban down before the messages it names are let out', () => {
    const s = screen({ maxMessages: 100 });
    poll(s.feed, 10, 1000, (i) => (i % 2 === 0
      ? { userId: 'UCtroll', userLogin: 'troll' }
      : { userId: 'UCok' + i }));
    frames(s, 3);
    expect(s.shown()).toEqual(['p0']);
    // Arriving in the same answer as the messages it acts on, with eight of
    // them still queued and unbuilt — the case the DOM cannot answer.
    s.feed.apply({ platform: 'youtube', channel: 'halcyon_tv', userId: 'UCtroll' });
    frames(s, 60);
    expect(s.shown()).toEqual(['p1', 'p3', 'p5', 'p7', 'p9']);
    expect(s.builds).toEqual(['p0', 'p1', 'p3', 'p5', 'p7', 'p9']);
  });

  it('lets a message expire while it is waiting its turn', () => {
    const s = screen({ maxMessages: 100, messageLifetime: 5, fadeDuration: 1 });
    poll(s.feed, 10, 1000);
    s.frame();
    // The lifetime runs from arrival for a paced message exactly as it does for
    // a coalesced one, so a queue held up by a missing frame expires in place
    // rather than appearing five seconds late.
    s.tick(5000);
    expect(s.builds).toEqual(['p0']);
    s.frame();
    expect(s.builds).toEqual(['p0']);
    s.tick(1000 + FADE_GRACE_MS);
    expect(s.shown()).toEqual([]);
    expect(s.timersLeft()).toBe(0);
  });

  it('holds the cap exactly across two paced answers', () => {
    const s = screen({ maxMessages: 10 });
    poll(s.feed, 8, 1000);
    frames(s, 44);
    for (let i = 0; i < 6; i++) {
      s.feed.add(message({ id: 'q' + i, platform: 'youtube' }), 1000);
    }
    frames(s, 44);
    expect(s.shown()).toEqual([
      'p4', 'p5', 'p6', 'p7',
      'q0', 'q1', 'q2', 'q3', 'q4', 'q5',
    ]);
  });
});
