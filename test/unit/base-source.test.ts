import { describe, expect, it, vi } from 'vitest';
import { PROBE_GRACE_MS } from '../../src/renderer/sources/base.js';
import { KEEPALIVE_MS, TwitchSource } from '../../src/renderer/sources/twitch.js';
import type { ChatMessage, SocketLike, SourceOptions } from '../../src/renderer/sources/types.js';

/**
 * Reconnect behaviour, exercised through TwitchSource because BaseSource is
 * abstract. Timers and randomness are injected, so the backoff curve is checked
 * arithmetically rather than by waiting.
 */

class FakeSocket implements SocketLike {
  readyState = 1;
  closed = false;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  // A real WebSocket throws on send() unless it is OPEN. A fake that accepts
  // anything would let a guard be deleted without a test noticing.
  send(data: string) {
    if (this.readyState !== 1) throw new Error('InvalidStateError');
    this.sent.push(data);
  }
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

/**
 * Bring a source all the way up. From here the newest timer is always the
 * watchdog, because arming it is the last thing every path does.
 */
function connected(over: Partial<SourceOptions> = {}) {
  const h = harness(over);
  h.source.connect();
  const socket = h.sockets[h.sockets.length - 1]!;
  socket.onopen?.();
  socket.sent.length = 0;
  return { ...h, socket };
}

/** Run the timer scheduled most recently, and report how long it was for. */
function fireLatest(h: { timers: { fn: () => void; ms: number }[] }): number {
  const timer = h.timers[h.timers.length - 1]!;
  timer.fn();
  return timer.ms;
}

const textOf = (msg?: ChatMessage) =>
  (msg?.parts ?? []).map((p) => (p.type === 'text' ? p.value : '')).join('');

/**
 * The case ws.onclose cannot see: a socket that stays open and simply stops
 * carrying anything — a laptop waking from sleep, a Wi-Fi handover, a NAT
 * timeout. Nothing is closed, so nothing is reported, and the dot stays green.
 */
describe('liveness watchdog', () => {
  it('asks before it gives up on a socket that has gone quiet', () => {
    // A quiet channel is the normal state of most channels. Silence on its own
    // must never be enough to tear a working connection down.
    const h = connected();
    expect(fireLatest(h)).toBe(KEEPALIVE_MS);
    expect(h.socket.sent).toEqual(['PING :overlay']);
    expect(h.socket.closed).toBe(false);
    expect(h.statuses.map((s) => s.state)).not.toContain('offline');
  });

  it('gives up and reconnects when the probe goes unanswered too', () => {
    const h = connected();
    fireLatest(h);                                    // silent: ask
    expect(fireLatest(h)).toBe(PROBE_GRACE_MS);       // no answer: give up
    expect(h.socket.closed).toBe(true);
    expect(h.statuses.map((s) => s.state)).toContain('offline');
    expect(h.statuses.at(-1)?.detail).toMatch(/^retry in \d+s$/);
  });

  it('reconnects through the one retry path, not a second one of its own', () => {
    const h = connected();
    fireLatest(h);
    fireLatest(h);
    expect(h.sockets).toHaveLength(1);
    fireLatest(h);                                    // the retry it scheduled
    expect(h.sockets).toHaveLength(2);
  });

  it('says so in the feed, so a stopped chat is not mistaken for a quiet one', () => {
    const h = connected();
    fireLatest(h);
    fireLatest(h);
    expect(h.messages.at(-1)).toMatchObject({ kind: 'system' });
    expect(textOf(h.messages.at(-1))).toMatch(/no reply.*twitch\/c/);
  });

  it('treats any frame at all as the answer, not a pong specifically', () => {
    // Twitch's PONG has no case in handle() and never has had. Counting
    // anything inbound is what makes that irrelevant — and what stops the
    // watchdog being fooled by a protocol detail changing underneath it.
    const h = connected();
    for (let i = 0; i < 5; i++) {
      fireLatest(h);                                              // silent: ask
      h.socket.onmessage?.({ data: 'PONG :tmi.twitch.tv\r\n' });   // answered
    }
    expect(h.socket.sent).toHaveLength(5);
    expect(h.socket.closed).toBe(false);
    expect(h.sockets).toHaveLength(1);
    expect(h.statuses.map((s) => s.state)).not.toContain('offline');
  });

  it('is armed by the socket opening, not by the first frame', () => {
    // A server that accepts the connection and then says nothing at all would
    // otherwise never be noticed: there is no first frame to start a clock on.
    const h = harness();
    h.source.connect();
    const socket = h.sockets[0]!;
    socket.onopen?.();
    fireLatest(h);
    fireLatest(h);
    expect(socket.closed).toBe(true);
    expect(h.statuses.map((s) => s.state)).toContain('offline');
  });

  it('does not start the backoff high after a long healthy session', () => {
    // A bad hour, then it connects and stays up for ages, then dies silently.
    // Waiting the 30s cap at that point would be punishing it for an outage
    // that ended long before.
    const h = harness();
    retryDelays(h, 8);                                  // backoff climbs to the cap
    h.source.connect();
    const socket = h.sockets[h.sockets.length - 1]!;
    socket.onopen?.();
    for (let i = 0; i < 200; i++) socket.onmessage?.({ data: 'PONG :tmi.twitch.tv\r\n' });
    fireLatest(h);
    fireLatest(h);
    expect(h.timers.at(-1)?.ms).toBe(retryDelays(harness(), 1)[0]);
  });

  it('is cleared when the socket is replaced, so timers do not pile up', () => {
    const h = connected();
    const watchdog = h.timers.length - 1;
    h.source.connect();
    expect(h.cleared).toContain(watchdog);
  });

  it('is cleared on destroy, and firing it afterwards does nothing', () => {
    const h = connected();
    const watchdog = h.timers[h.timers.length - 1]!;
    const handle = h.timers.length - 1;
    h.source.destroy();
    expect(h.cleared).toContain(handle);

    const before = h.timers.length;
    watchdog.fn();
    watchdog.fn();
    expect(h.timers.length).toBe(before);              // nothing re-armed
    expect(h.sockets).toHaveLength(1);                 // and nothing reconnected
  });

  it('collapses both waits to one value for the end-to-end harness', () => {
    // The stall scenario cannot sit through four minutes. A real install sets
    // nothing and gets the platform's own numbers, as the tests above show.
    const h = connected({ watchdogMs: 2500 });
    expect(fireLatest(h)).toBe(2500);
    expect(fireLatest(h)).toBe(2500);
    expect(h.socket.closed).toBe(true);
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
