import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpdater } from '../../src/main/updater/index.js';
import { REQUIRED_FILES } from '../../src/main/updater/manifest.js';
import { GoodGameSource } from '../../src/renderer/sources/goodgame.js';
import { TwitchSource } from '../../src/renderer/sources/twitch.js';
import type { SocketLike } from '../../src/renderer/sources/types.js';

/**
 * The fallbacks that apply when a collaborator is not supplied, and the "field
 * is absent" paths for data coming off the wire. Both matter: the first is what
 * production actually runs when wiring omits an option, and the second is what
 * happens when a platform changes its payload.
 */

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  send(d: string) { this.sent.push(d); }
  close() {}
}

const cfg = () => ({ emotes: true, thirdPartyEmotes: true, exactColors: false });

describe('source defaults', () => {
  it('uses no-op handlers and real clock/random when none are given', () => {
    let socket!: FakeSocket;
    const src = new TwitchSource({
      channel: 'c',
      onMessage: () => {},
      getConfig: cfg,
      createSocket: () => { socket = new FakeSocket(); return socket; },
    });

    src.connect();                                   // default onStatus
    socket.onopen?.();                               // default random (nick)
    socket.onmessage?.({ data: ':tmi.twitch.tv CLEARCHAT #c :someone' });   // default onRemove
    socket.onmessage?.({ data: ':a!a@a PRIVMSG #c :hi' });                  // default now
    expect(socket.sent.some((l) => l.startsWith('NICK justinfan'))).toBe(true);
    src.destroy();
  });

  it('warns nowhere by default when a catalogue fails', async () => {
    const src = new TwitchSource({
      channel: 'c',
      onMessage: () => {},
      getConfig: cfg,
      createSocket: () => new FakeSocket(),
      assets: {
        twitchThirdParty: vi.fn().mockRejectedValue(new Error('x')),
        twitchBadges: vi.fn().mockRejectedValue(new Error('y')),
        goodgameSmiles: vi.fn(),
      },
    });
    src.roomId = '1';
    await expect(src.loadAssets()).resolves.toBeUndefined();
  });

  it('reports a helpful error when a lookup is attempted with no http', async () => {
    const src = new GoodGameSource({
      channel: 'named-channel',
      onMessage: () => {},
      getConfig: cfg,
      createSocket: () => new FakeSocket(),
    });
    await expect(src.resolveChannelId()).rejects.toThrow('no http available');
  });

  it('schedules with the real timers by default', () => {
    vi.useFakeTimers();
    let socket!: FakeSocket;
    const src = new TwitchSource({
      channel: 'c',
      onMessage: () => {},
      getConfig: cfg,
      createSocket: () => { socket = new FakeSocket(); return socket; },
    });
    src.connect();
    socket.onclose?.();                              // default setTimeoutFn schedules a retry
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    src.destroy();                                   // default clearTimeoutFn
    vi.useRealTimers();
  });
});

describe('twitch wire edge cases', () => {
  function harness() {
    let socket!: FakeSocket;
    const messages: { userLogin: string }[] = [];
    const src = new TwitchSource({
      channel: 'c',
      onMessage: (m) => messages.push(m as never),
      getConfig: cfg,
      createSocket: () => { socket = new FakeSocket(); return socket; },
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {},
      random: () => 0,
      now: () => 0,
    });
    src.connect();
    return { src, socket: () => socket, messages };
  }

  it('falls back to an empty login when there is neither prefix nor display name', () => {
    const h = harness();
    h.socket().onmessage?.({ data: 'PRIVMSG #c :hi' });
    expect(h.messages.at(-1)?.userLogin).toBe('');
  });

  it('ignores a close from a socket that has already been replaced', () => {
    const h = harness();
    // Capture the handler before reconnect detaches it, so the guard is reached.
    const staleHandler = h.socket().onclose;
    const stale = h.socket();
    h.src.connect();
    expect(h.socket()).not.toBe(stale);
    const current = h.socket();
    staleHandler?.();
    expect(current.onclose).not.toBeNull();          // the live socket is untouched
  });

  it('skips the keepalive ping when the socket has gone', () => {
    const timers: (() => void)[] = [];
    let socket!: FakeSocket;
    const src = new TwitchSource({
      channel: 'c',
      onMessage: () => {},
      getConfig: cfg,
      createSocket: () => { socket = new FakeSocket(); return socket; },
      setTimeoutFn: (fn) => { timers.push(fn as () => void); return timers.length; },
      clearTimeoutFn: () => {},
      random: () => 0,
      now: () => 0,
    });
    src.connect();
    socket.onopen?.();
    socket.onclose?.();                              // clears this.ws
    expect(() => timers.forEach((fn) => fn())).not.toThrow();
  });
});

describe('goodgame wire edge cases', () => {
  function connected() {
    const messages: { user: string; userId?: string; ts: number; parts: unknown[] }[] = [];
    const statuses: { state: string; detail: string }[] = [];
    const src = new GoodGameSource({
      channel: '5',
      onMessage: (m) => messages.push(m as never),
      onStatus: (_s, state, detail) => statuses.push({ state, detail }),
      getConfig: cfg,
      createSocket: () => new FakeSocket(),
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {},
      now: () => 4242,
    });
    src.channelId = '5';
    return { src, messages, statuses };
  }

  it('renders a message with every optional field missing', () => {
    const h = connected();
    h.src.handle({ type: 'message', data: { channel_id: '5', message_id: 'm' } });
    expect(h.messages.at(-1)).toMatchObject({ user: '', userId: '', ts: 4242 });
  });

  it('joins without a channel name', () => {
    const h = connected();
    h.src.handle({ type: 'success_join', data: {} });
    expect(h.statuses.at(-1)).toEqual({ state: 'online', detail: '' });
  });

  it('prefers errorMsg, then message, then a generic error', () => {
    const h = connected();
    h.src.handle({ type: 'error', data: { message: 'from message' } });
    expect(h.statuses.at(-1)?.detail).toBe('from message');
  });

  it('handles a frame with no data at all', () => {
    const h = connected();
    h.src.handle({ type: 'success_join' });
    expect(h.statuses.at(-1)?.state).toBe('online');
  });
});

describe('updater default clock', () => {
  let tmp: string;

  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-def-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('stamps the marker with the real time when no clock is injected', async () => {
    const files: Record<string, unknown> = {};
    for (const f of REQUIRED_FILES) {
      files[f] = {
        sha256: createHash('sha256').update(Buffer.from('x', 'utf8')).digest('hex'),
        enc: 'utf8',
        data: 'x',
      };
    }
    const gz = gzipSync(Buffer.from(JSON.stringify({ version: '1.0.1', files }), 'utf8'));
    const incomingDir = path.join(tmp, 'payload-new');

    const updater = createUpdater({
      fetch: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
      })) as never,
      releaseApi: 'https://api.example/latest',
      incomingDir: () => incomingDir,
      currentVersion: () => '1.0.0',
      quarantinedVersion: () => null,
    });

    await updater.download('https://cdn/p');
    const marker = JSON.parse(fs.readFileSync(path.join(incomingDir, '.staged'), 'utf8'));
    expect(Date.parse(marker.at)).not.toBeNaN();
  });
});
