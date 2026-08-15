import { describe, expect, it, vi } from 'vitest';
import { channelStatusUrl, ggBadges, GoodGameSource } from '../../src/renderer/sources/goodgame.js';
import type { ChatMessage, RemoveRequest, SocketLike, SourceOptions } from '../../src/renderer/sources/types.js';

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  send(data: string) { this.sent.push(data); }
  close() {}
}

function harness(overrides: Partial<SourceOptions> = {}) {
  const messages: ChatMessage[] = [];
  const removals: RemoveRequest[] = [];
  const statuses: { state: string; detail: string }[] = [];
  const warnings: string[] = [];
  let socket!: FakeSocket;

  const source = new GoodGameSource({
    channel: 'annieflowers',
    onMessage: (m) => messages.push(m),
    onRemove: (r) => removals.push(r),
    onStatus: (_s, state, detail) => statuses.push({ state, detail }),
    getConfig: () => ({ emotes: true, thirdPartyEmotes: true, exactColors: true }),
    createSocket: () => { socket = new FakeSocket(); return socket; },
    httpJson: async () => ({ '138653': { stream_id: 138653, key: 'annieflowers' } }),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
    random: () => 0.5,
    now: () => 1_700_000_000_000,
    onWarn: (m) => warnings.push(m),
    ...overrides,
  });

  return { source, messages, removals, statuses, warnings, socket: () => socket };
}

describe('channelStatusUrl', () => {
  it('encodes the channel name', () => {
    expect(channelStatusUrl('a b')).toBe(
      'https://goodgame.ru/api/getchannelstatus?fmt=json&id=a%20b',
    );
  });
});

describe('ggBadges', () => {
  it('maps the rights levels to roles', () => {
    expect(ggBadges({ user_rights: 40 })[0]).toMatchObject({ label: 'ADMIN' });
    expect(ggBadges({ staff: 1 })[0]).toMatchObject({ label: 'ADMIN' });
    expect(ggBadges({ user_rights: 20 })[0]).toMatchObject({ label: 'HOST' });
    expect(ggBadges({ user_rights: 10 })[0]).toMatchObject({ label: 'MOD' });
    expect(ggBadges({ user_rights: 0 })).toEqual([]);
  });

  it('adds a premium chip alongside the role', () => {
    const badges = ggBadges({ user_rights: 20, premium: 1 });
    expect(badges.map((b) => b.label)).toEqual(['HOST', 'PREM']);
  });

  it('never claims artwork it does not have', () => {
    expect(ggBadges({ user_rights: 20 })[0]?.url).toBeNull();
  });
});

describe('GoodGameSource.resolveChannelId', () => {
  it('passes a numeric channel straight through', async () => {
    const h = harness({ channel: '138653' });
    await expect(h.source.resolveChannelId()).resolves.toBe('138653');
  });

  it('looks a name up through the status endpoint', async () => {
    const h = harness();
    await expect(h.source.resolveChannelId()).resolves.toBe('138653');
  });

  it('throws when the channel does not exist', async () => {
    const h = harness({ httpJson: async () => ({}) });
    await expect(h.source.resolveChannelId()).rejects.toThrow('channel not found');
  });

  it('throws when the payload has no stream id', async () => {
    const h = harness({ httpJson: async () => ({ x: { key: 'a' } }) });
    await expect(h.source.resolveChannelId()).rejects.toThrow('channel not found');
  });
});

describe('GoodGameSource.connect', () => {
  it('joins by numeric id with the trailing-slash endpoint', async () => {
    const h = harness();
    await h.source.connect();
    h.socket().onopen?.();
    expect(JSON.parse(h.socket().sent[0] as string)).toEqual({
      type: 'join',
      data: { channel_id: '138653', hidden: false },
    });
  });

  it('reports a lookup failure and schedules a retry', async () => {
    const h = harness({ httpJson: async () => { throw new Error('offline'); } });
    await h.source.connect();
    expect(h.statuses.some((s) => s.detail === 'channel lookup failed: offline')).toBe(true);
  });

  it('does nothing once destroyed', async () => {
    const h = harness();
    h.source.destroy();
    await h.source.connect();
    expect(h.statuses).toEqual([]);
  });

  it('loads smiles but survives them failing', async () => {
    const goodgameSmiles = vi.fn().mockRejectedValue(new Error('nope'));
    const h = harness({ assets: { goodgameSmiles, twitchThirdParty: vi.fn(), twitchBadges: vi.fn() } });
    await h.source.connect();
    await new Promise((r) => setTimeout(r, 0));
    expect(goodgameSmiles).toHaveBeenCalledWith('138653');
    expect(h.warnings).toEqual(['gg smiles failed: nope']);
  });

  it('reports socket errors and retries on close', async () => {
    const h = harness();
    await h.source.connect();
    h.socket().onerror?.();
    expect(h.statuses.some((s) => s.state === 'error')).toBe(true);
    h.socket().onclose?.();
    expect(h.statuses.some((s) => s.state === 'offline')).toBe(true);
  });

  it('ignores unparseable frames', async () => {
    const h = harness();
    await h.source.connect();
    h.socket().onmessage?.({ data: 'not json' });
    expect(h.messages).toEqual([]);
  });
});

describe('GoodGameSource.handle', () => {
  function connected() {
    const h = harness();
    h.source.channelId = '138653';
    return h;
  }

  it('announces a successful join', () => {
    const h = connected();
    h.source.handle({ type: 'success_join', data: { channel_name: 'stream' } });
    expect(h.statuses.at(-1)).toEqual({ state: 'online', detail: 'stream' });
    expect(h.messages.at(-1)?.parts[0]).toEqual({
      type: 'text', value: 'connected — goodgame/annieflowers',
    });
  });

  it('renders a chat message', () => {
    const h = connected();
    h.source.handle({
      type: 'message',
      data: {
        channel_id: '138653', user_id: 7, user_name: 'Nero', text: 'hi',
        message_id: 'm1', timestamp: 1700000000, color: 'streamer', user_rights: 20,
      },
    });
    expect(h.messages.at(-1)).toMatchObject({
      id: 'goodgame:annieflowers:m1',
      user: 'Nero',
      userLogin: 'nero',
      userId: '7',
      ts: 1700000000000,
    });
    expect(h.messages.at(-1)?.badges[0]?.label).toBe('HOST');
  });

  it('ignores messages for another channel on the shared socket', () => {
    const h = connected();
    h.source.handle({ type: 'message', data: { channel_id: '999', text: 'x', message_id: 'm' } });
    expect(h.messages).toEqual([]);
  });

  it('falls back to the current time when the frame has none', () => {
    const h = connected();
    h.source.handle({ type: 'message', data: { channel_id: '138653', message_id: 'm', text: 'x' } });
    expect(h.messages.at(-1)?.ts).toBe(1_700_000_000_000);
  });

  it('removes a deleted message', () => {
    const h = connected();
    h.source.handle({ type: 'remove_message', data: { message_id: 'm1' } });
    expect(h.removals).toEqual([{ ids: ['goodgame:annieflowers:m1'] }]);
  });

  it('removes a banned user by name', () => {
    const h = connected();
    h.source.handle({ type: 'ban', data: { user_name: 'BadUser' } });
    expect(h.removals).toEqual([{ platform: 'goodgame', user: 'baduser' }]);
    h.removals.length = 0;
    h.source.handle({ type: 'ban_user', data: {} });
    expect(h.removals).toEqual([]);
  });

  it('surfaces protocol errors', () => {
    const h = connected();
    h.source.handle({ type: 'error', data: { errorMsg: 'nope' } });
    expect(h.statuses.at(-1)).toEqual({ state: 'error', detail: 'nope' });
    h.source.handle({ type: 'error', data: {} });
    expect(h.statuses.at(-1)?.detail).toBe('chat error');
  });

  it('ignores unknown and malformed frames', () => {
    const h = connected();
    h.source.handle({ type: 'channel_counters', data: {} });
    h.source.handle(null);
    h.source.handle('string');
    expect(h.messages).toEqual([]);
  });
});

describe('GoodGameSource.buildParts', () => {
  it('replaces :key: smiles', () => {
    const h = harness();
    h.source.emoteMap = new Map([['pekaclap', { url: 'https://gg/gif', fallback: 'https://gg/png' }]]);
    expect(h.source.buildParts('hi :pekaclap: there')).toEqual([
      { type: 'text', value: 'hi ' },
      { type: 'emote', url: 'https://gg/gif', name: 'pekaclap', fallback: 'https://gg/png' },
      { type: 'text', value: ' there' },
    ]);
  });

  it('omits the fallback when the smile is not animated', () => {
    const h = harness();
    h.source.emoteMap = new Map([['a', { url: 'https://gg/png' }]]);
    expect(h.source.buildParts(':a:')).toEqual([
      { type: 'emote', url: 'https://gg/png', name: 'a' },
    ]);
  });

  it('leaves colon text that is not a known smile alone', () => {
    const h = harness();
    h.source.emoteMap = new Map([['a', { url: 'u' }]]);
    expect(h.source.buildParts('ratio 3:4: end')).toEqual([
      { type: 'text', value: 'ratio 3:4: end' },
    ]);
  });

  it('matches smile keys case-insensitively', () => {
    const h = harness();
    h.source.emoteMap = new Map([['peka', { url: 'u' }]]);
    expect(h.source.buildParts(':PEKA:')[0]).toMatchObject({ type: 'emote' });
  });

  it('returns plain text when there are no smiles or they are off', () => {
    const h = harness();
    expect(h.source.buildParts('hello')).toEqual([{ type: 'text', value: 'hello' }]);

    const off = harness({
      getConfig: () => ({ emotes: false, thirdPartyEmotes: true, exactColors: true }),
    });
    off.source.emoteMap = new Map([['a', { url: 'u' }]]);
    expect(off.source.buildParts(':a:')).toEqual([{ type: 'text', value: ':a:' }]);
  });
});
