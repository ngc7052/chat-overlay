import { describe, expect, it, vi } from 'vitest';
import { TwitchSource } from '../../src/renderer/sources/twitch.js';
import type { ChatMessage, SocketLike, SourceOptions } from '../../src/renderer/sources/types.js';

/**
 * Reconnect behaviour, exercised through TwitchSource because BaseSource is
 * abstract. Timers and randomness are injected, so the backoff curve is checked
 * arithmetically rather than by waiting.
 */

class FakeSocket implements SocketLike {
  readyState = 1;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  send() {}
  close() { this.closed = true; }
}

function harness(over: Partial<SourceOptions> = {}) {
  const timers: { fn: () => void; ms: number }[] = [];
  const cleared: unknown[] = [];
  const statuses: { state: string; detail: string }[] = [];
  const messages: ChatMessage[] = [];
  const sockets: FakeSocket[] = [];

  const source = new TwitchSource({
    channel: 'c',
    onMessage: (m) => messages.push(m),
    onStatus: (_s, state, detail) => statuses.push({ state, detail }),
    getConfig: () => ({ emotes: true, thirdPartyEmotes: true, exactColors: false }),
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    setTimeoutFn: (fn, ms) => { timers.push({ fn: fn as () => void, ms }); return timers.length - 1; },
    clearTimeoutFn: (h) => cleared.push(h),
    random: () => 0,
    now: () => 1000,
    ...over,
  });

  return { source, timers, cleared, statuses, messages, sockets };
}

/** The delay scheduled for the nth consecutive failure. */
function retryDelays(h: ReturnType<typeof harness>, count: number): number[] {
  const delays: number[] = [];
  for (let i = 0; i < count; i++) {
    h.source.connect();
    h.sockets[h.sockets.length - 1]?.onclose?.();
    const retry = h.timers[h.timers.length - 1];
    delays.push(retry?.ms ?? -1);
  }
  return delays;
}

describe('reconnect backoff', () => {
  it('grows with each consecutive failure', () => {
    const h = harness();
    const delays = retryDelays(h, 4);
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(delays[0]).toBeLessThan(delays[3] as number);
  });

  it('is capped so a long outage does not stop retrying', () => {
    const h = harness();
    const delays = retryDelays(h, 12);
    expect(Math.max(...delays)).toBeLessThanOrEqual(30000 * 1.25);
  });

  it('adds jitter so many channels do not reconnect in lockstep', () => {
    const none = harness({ random: () => 0 });
    const full = harness({ random: () => 1 });
    expect(retryDelays(full, 1)[0]).toBeGreaterThan(retryDelays(none, 1)[0] as number);
  });

  it('resets once a connection succeeds', () => {
    const h = harness();
    retryDelays(h, 3);
    h.source.connect();
    h.sockets[h.sockets.length - 1]?.onopen?.();      // success resets the counter
    h.sockets[h.sockets.length - 1]?.onclose?.();
    const afterSuccess = h.timers[h.timers.length - 1]?.ms;
    expect(afterSuccess).toBe(retryDelays(harness(), 1)[0]);
  });

  it('reports how long the next attempt is away', () => {
    const h = harness();
    retryDelays(h, 1);
    expect(h.statuses.some((s) => /^retry in \d+s$/.test(s.detail))).toBe(true);
  });

  it('stops scheduling once destroyed', () => {
    const h = harness();
    h.source.connect();
    h.source.destroy();
    const before = h.timers.length;
    h.sockets[0]?.onclose?.();
    expect(h.timers.length).toBe(before);
  });

  it('runs connect again when the retry timer fires', () => {
    const h = harness();
    h.source.connect();
    h.sockets[0]?.onclose?.();
    const socketsBefore = h.sockets.length;
    h.timers[h.timers.length - 1]?.fn();
    expect(h.sockets.length).toBe(socketsBefore + 1);
  });
});

describe('socket lifecycle', () => {
  it('detaches and closes the previous socket on reconnect', () => {
    const h = harness();
    h.source.connect();
    const first = h.sockets[0]!;
    h.source.connect();
    expect(first.closed).toBe(true);
    expect(first.onclose).toBeNull();
  });

  it('survives a socket that throws on close', () => {
    const h = harness({
      createSocket: () => ({
        readyState: 1, send() {}, close() { throw new Error('already gone'); },
        onopen: null, onmessage: null, onerror: null, onclose: null,
      }),
    });
    h.source.connect();
    expect(() => h.source.destroy()).not.toThrow();
  });

  it('closing when never connected is harmless', () => {
    const h = harness();
    expect(() => h.source.destroy()).not.toThrow();
  });
});

describe('system messages', () => {
  it('carries the channel and a neutral colour', () => {
    const h = harness();
    h.source.connect();
    h.sockets[0]?.onmessage?.({ data: ':tmi.twitch.tv NOTICE #c :hello' });
    expect(h.messages.at(-1)).toMatchObject({
      kind: 'system', channel: 'c', user: '', color: '#b9c6dc',
    });
  });

  it('gives every system line a distinct id', () => {
    const h = harness({ random: Math.random });
    h.source.connect();
    h.sockets[0]?.onmessage?.({ data: ':tmi.twitch.tv NOTICE #c :one' });
    h.sockets[0]?.onmessage?.({ data: ':tmi.twitch.tv NOTICE #c :two' });
    const [a, b] = h.messages.slice(-2);
    expect(a?.id).not.toBe(b?.id);
  });
});

describe('defaults', () => {
  it('falls back to no-op collaborators when none are supplied', async () => {
    const source = new TwitchSource({
      channel: 'c',
      onMessage: () => {},
      getConfig: () => ({ emotes: false, thirdPartyEmotes: false, exactColors: false }),
      createSocket: () => new FakeSocket(),
    });
    // onRemove, onStatus, onWarn and httpJson all default; none of these throw.
    expect(() => source.connect()).not.toThrow();
    expect(source.key).toBe('twitch:c');
    await expect(source.loadAssets()).resolves.toBeUndefined();
    source.destroy();
  });

  it('uses the real timer functions by default', () => {
    vi.useFakeTimers();
    const source = new TwitchSource({
      channel: 'c',
      onMessage: () => {},
      getConfig: () => ({ emotes: false, thirdPartyEmotes: false, exactColors: false }),
      createSocket: () => new FakeSocket(),
    });
    source.connect();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    source.destroy();
    vi.useRealTimers();
  });
});
