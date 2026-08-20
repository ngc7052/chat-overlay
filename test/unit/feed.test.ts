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
