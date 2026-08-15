import { describe, expect, it } from 'vitest';
import { GoodGameSource } from '../../src/renderer/sources/goodgame.js';
import type { SocketLike } from '../../src/renderer/sources/types.js';

class FakeSocket implements SocketLike {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  send() {}
  close() {}
}

const cfg = () => ({ emotes: true, thirdPartyEmotes: true, exactColors: true });

function make(over: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  const statuses: { state: string; detail: string }[] = [];
  const src = new GoodGameSource({
    channel: 'named',
    onMessage: () => {},
    onStatus: (_s, state, detail) => statuses.push({ state, detail }),
    getConfig: cfg,
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    httpJson: async () => ({ '1': { stream_id: 1 } }),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
    now: () => 0,
    ...over,
  });
  return { src, sockets, statuses };
}

describe('resolveChannelId defensive paths', () => {
  it('rejects a response that is not an object', async () => {
    const { src } = make({ httpJson: async () => 'not an object' });
    await expect(src.resolveChannelId()).rejects.toThrow('channel not found');
  });

  it('rejects a response whose first entry is not an object', async () => {
    const { src } = make({ httpJson: async () => ({ a: 'string' }) });
    await expect(src.resolveChannelId()).rejects.toThrow('channel not found');
  });

  it('rejects an empty stream id', async () => {
    const { src } = make({ httpJson: async () => ({ a: { stream_id: '' } }) });
    await expect(src.resolveChannelId()).rejects.toThrow('channel not found');
  });
});

describe('connect lifecycle', () => {
  it('stops if the source is destroyed while the channel lookup is in flight', async () => {
    // Without this check a destroyed source would still open a socket.
    let release!: (v: unknown) => void;
    const pending = new Promise((r) => { release = r; });
    const { src, sockets } = make({
      httpJson: async () => { await pending; return { a: { stream_id: 1 } }; },
    });

    const connecting = src.connect();
    src.destroy();
    release({});
    await connecting;
    expect(sockets).toHaveLength(0);
  });

  it('ignores a close from a socket that has been replaced', async () => {
    const h = make();
    await h.src.connect();
    const staleHandler = h.sockets[0]?.onclose;
    await h.src.connect();
    h.statuses.length = 0;
    staleHandler?.();
    expect(h.statuses).toEqual([]);
  });
});

describe('buildParts fallback', () => {
  it('returns plain text when a known smile key produces no parts', () => {
    // The regex matches but the key is unknown, so nothing was substituted and
    // the original text must survive intact.
    const { src } = make();
    src.emoteMap = new Map([['known', { url: 'u' }]]);
    expect(src.buildParts(':unknown:')).toEqual([{ type: 'text', value: ':unknown:' }]);
  });

  it('returns nothing for an empty message', () => {
    const { src } = make();
    src.emoteMap = new Map([['known', { url: 'u' }]]);
    expect(src.buildParts('')).toEqual([]);
  });
});
