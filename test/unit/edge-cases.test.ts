import { describe, expect, it, vi } from 'vitest';
import { choosePayload } from '../../src/boot/payload.js';
import { createUpdater } from '../../src/main/updater/index.js';
import { addSevenTv, normaliseGgCatalogue } from '../../src/renderer/emotes/catalogue.js';
import { GoodGameSource } from '../../src/renderer/sources/goodgame.js';
import { TwitchSource } from '../../src/renderer/sources/twitch.js';
import type { EmoteEntry, SocketLike } from '../../src/renderer/sources/types.js';
import { statusDots } from '../../src/renderer/view.js';

/**
 * Defensive paths that the happy-path tests never reach. They exist because the
 * inputs come from third-party APIs and a filesystem that can be interrupted,
 * so "cannot happen" is not a safe assumption.
 */

class FakeSocket implements SocketLike {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  send() {}
  close() {}
}

const baseConfig = () => ({ emotes: true, thirdPartyEmotes: true, exactColors: false });

describe('choosePayload state edge cases', () => {
  it('treats a matching version with no trial count as a first attempt', () => {
    expect(choosePayload({
      bundledVersion: '1.0.0',
      stagedVersion: '1.0.1',
      state: { version: '1.0.1' },      // written by an older build, no counter
      recovering: false,
    })).toEqual({ use: 'staged', trials: 1 });
  });
});

describe('updater without AbortSignal.timeout', () => {
  it('still performs the request when the runtime cannot time out', async () => {
    const original = AbortSignal.timeout;
    // Older runtimes lack it; the fetch should go out untimed rather than throw.
    (AbortSignal as { timeout?: unknown }).timeout = undefined;
    try {
      const fetchSpy = vi.fn(async (_url: string, _init: { signal?: AbortSignal }) => ({
        ok: true, status: 200, json: async () => ({ tag_name: 'v1.0.1' }),
        arrayBuffer: async () => new ArrayBuffer(0),
      }));
      const updater = createUpdater({
        fetch: fetchSpy as never,
        releaseApi: 'https://api.example/latest',
        incomingDir: () => '/tmp/none',
        currentVersion: () => '1.0.0',
        quarantinedVersion: () => null,
      });
      await expect(updater.check()).resolves.toMatchObject({ version: '1.0.1' });
      expect(fetchSpy.mock.calls[0]?.[1]).not.toHaveProperty('signal');
    } finally {
      (AbortSignal as { timeout?: unknown }).timeout = original;
    }
  });
});

describe('statusDots with an unexpected state', () => {
  it('passes the state through, leaving the neutral dot to the stylesheet', () => {
    // Only online/error/connecting are given a colour; anything else lands on
    // the default grey rather than on no dot at all.
    expect(statusDots(
      [{ key: 'k', platform: 'twitch', channel: 'c' }],
      new Map([['k', { state: 'offline' as const, detail: '' }]]),
    )).toEqual([{ key: 'k', label: 'tw/c', state: 'offline', title: 'tw/c — offline' }]);
  });
});

describe('catalogue defensive paths', () => {
  it('skips a GoodGame smile with no key at all', () => {
    expect(normaliseGgCatalogue([{ images: { small: '//gg/a.png' } }])).toEqual([]);
  });

  it('skips a 7TV emote whose host url is empty', () => {
    const map = new Map<string, EmoteEntry>();
    addSevenTv(map, { emotes: [{ id: 'e', name: 'A', data: { host: { url: '' } } }] });
    expect(map.size).toBe(0);
  });

  it('copes with nulls inside the 7TV file list', () => {
    const map = new Map<string, EmoteEntry>();
    addSevenTv(map, {
      emotes: [{ id: 'e', name: 'A', data: { host: { url: '//h/e', files: [null, { name: '2x.webp' }] } } }],
    });
    expect(map.get('A')?.url).toBe('https://h/e/2x.webp');
  });
});

describe('twitch defensive paths', () => {
  function source(channel = 'c') {
    let socket!: FakeSocket;
    const messages: { kind: string; parts: { value?: string }[] }[] = [];
    const src = new TwitchSource({
      channel,
      onMessage: (m) => messages.push(m as never),
      getConfig: baseConfig,
      createSocket: () => { socket = new FakeSocket(); return socket; },
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {},
      random: () => 0,
      now: () => 0,
    });
    return { src, socket: () => socket, messages };
  }

  it('accepts an empty channel name without crashing', () => {
    expect(source('').src.channel).toBe('');
  });

  it('handles a NOTICE with no text', () => {
    const h = source();
    h.src.connect();
    h.socket().onmessage?.({ data: ':tmi.twitch.tv NOTICE' });
    expect(h.messages.at(-1)?.kind).toBe('system');
  });

  it('handles a PRIVMSG with no body', () => {
    const h = source();
    h.src.connect();
    h.socket().onmessage?.({ data: ':a!a@a PRIVMSG' });
    expect(h.messages.at(-1)?.kind).toBe('chat');
  });

  it('does not schedule a retry after being destroyed', () => {
    const timers: unknown[] = [];
    let socket!: FakeSocket;
    const src = new TwitchSource({
      channel: 'c',
      onMessage: () => {},
      getConfig: baseConfig,
      createSocket: () => { socket = new FakeSocket(); return socket; },
      setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimeoutFn: () => {},
      random: () => 0,
      now: () => 0,
    });
    src.connect();
    src.destroy();
    const before = timers.length;
    src.handle('RECONNECT');       // would normally schedule a reconnect
    expect(timers.length).toBe(before);
    expect(socket).toBeDefined();
  });
});

describe('goodgame defensive paths', () => {
  it('routes a frame arriving on the socket through handle', async () => {
    let socket!: FakeSocket;
    const messages: { id: string }[] = [];
    const src = new GoodGameSource({
      channel: '5',
      onMessage: (m) => messages.push(m as never),
      getConfig: baseConfig,
      createSocket: () => { socket = new FakeSocket(); return socket; },
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {},
      now: () => 0,
    });
    await src.connect();
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'message',
        data: { channel_id: '5', message_id: 'm9', text: 'hi', user_name: 'n' },
      }),
    });
    expect(messages.at(-1)?.id).toBe('goodgame:5:m9');
  });
});
