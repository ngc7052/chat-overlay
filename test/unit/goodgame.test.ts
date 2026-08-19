import { describe, expect, it, vi } from 'vitest';
import {
  channelStatusUrl, ggBadges, ggChannelIconUrl, ggIconUrl, ggPlusIconUrl, GoodGameSource,
} from '../../src/renderer/sources/goodgame.js';
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

  it('never claims artwork it does not have for a role', () => {
    // GoodGame sends no icon for moderator or host, so those stay text chips.
    expect(ggBadges({ user_rights: 20 })[0]?.url).toBeNull();
  });

  it('prefers the channel\'s own subscriber artwork over the shared icon', () => {
    // This is what makes a real GoodGame chat colourful; the shared icons are
    // monochrome fallbacks.
    const [badge] = ggBadges({ icon: 'star', premium: 1, channel_id: '5', resubs: { '5': 2 } });
    expect(badge).toMatchObject({
      kind: 'gg-icon',
      url: 'https://goodgame.ru/files/icons/5-2-48.png',
      title: 'subscriber',
    });
  });

  it('falls back to the shared icon when the channel has no artwork', () => {
    const [badge] = ggBadges({ icon: 'star', premium: 1, channel_id: '5', resubs: {} });
    expect(badge?.url).toContain('StarFull24px.svg');
  });

  it('only substitutes artwork for the star icon', () => {
    const [badge] = ggBadges({ icon: 'cup', channel_id: '5', resubs: { '5': 2 } });
    expect(badge?.url).toContain('Cup24px.svg');
  });

  it('renders the per-user icon GoodGame actually sends', () => {
    const badges = ggBadges({ icon: 'star', premium: 1 });
    expect(badges).toEqual([{
      kind: 'gg-icon',
      label: 'STAR',
      url: 'https://static.goodgame.ru/images/chat-svg-icons/StarFull24px.svg',
      title: 'star',
    }]);
  });

  it('keeps a premium chip only when there is no icon to show', () => {
    expect(ggBadges({ premium: 1 }).map((b) => b.label)).toEqual(['PREM']);
    expect(ggBadges({ premium: 1, icon: 'eagle' }).map((b) => b.label)).toEqual(['EAGL']);
  });

  it('adds a GoodGame+ badge for the tier held', () => {
    const badges = ggBadges({ gg_plus_tier: 12 });
    expect(badges[0]).toMatchObject({
      kind: 'premium',
      label: 'GG+',
      url: 'https://static.goodgame.ru/images/chat-svg-icons/gg-12-24px.svg',
    });
  });

  it('puts the role first, then the icon', () => {
    expect(ggBadges({ user_rights: 20, icon: 'star' }).map((b) => b.kind))
      .toEqual(['broadcaster', 'gg-icon']);
  });
});

describe('ggChannelIconUrl', () => {
  it('builds the channel-specific subscriber icon from the tier', () => {
    // The tier lives in resubs, keyed by the channel the message came from.
    expect(ggChannelIconUrl('5', { '5': 1 }))
      .toBe('https://goodgame.ru/files/icons/5-1-48.png');
    expect(ggChannelIconUrl('1644', { '1644': 3 }))
      .toBe('https://goodgame.ru/files/icons/1644-3-48.png');
  });

  it('clamps to the highest tier artwork that exists', () => {
    expect(ggChannelIconUrl('5', { '5': 99 })).toContain('5-7-48.png');
  });

  it('ignores a subscription to some other channel', () => {
    expect(ggChannelIconUrl('5', { '138653': 4 })).toBeNull();
  });

  it('returns null without a tier or a numeric channel', () => {
    expect(ggChannelIconUrl('5', {})).toBeNull();
    expect(ggChannelIconUrl('5', null)).toBeNull();
    expect(ggChannelIconUrl('5', { '5': 0 })).toBeNull();
    expect(ggChannelIconUrl('notachannel', { notachannel: 2 })).toBeNull();
    expect(ggChannelIconUrl(undefined, { '5': 1 })).toBeNull();
  });
});

describe('ggIconUrl', () => {
  it('maps the names GoodGame sends to its own files', () => {
    expect(ggIconUrl('star')).toContain('StarFull24px.svg');
    expect(ggIconUrl('EAGLE')).toContain('Eagle24px.svg');
    expect(ggIconUrl('moderator')).toContain('Sword24px.svg');
  });

  it('returns null for none, unknown names and junk', () => {
    expect(ggIconUrl('none')).toBeNull();
    expect(ggIconUrl('')).toBeNull();
    expect(ggIconUrl(undefined)).toBeNull();
    expect(ggIconUrl('not-a-real-icon')).toBeNull();
  });
});

describe('ggPlusIconUrl', () => {
  it('uses the exact tier when one exists', () => {
    expect(ggPlusIconUrl(3)).toContain('gg-3-24px.svg');
    expect(ggPlusIconUrl(96)).toContain('gg-96-24px.svg');
  });

  it('rounds down to the highest tier badge that exists', () => {
    expect(ggPlusIconUrl(5)).toContain('gg-3-24px.svg');
    expect(ggPlusIconUrl(200)).toContain('gg-96-24px.svg');
  });

  it('shows nothing below the first tier', () => {
    expect(ggPlusIconUrl(0)).toBeNull();
    expect(ggPlusIconUrl(undefined)).toBeNull();
    expect(ggPlusIconUrl('nonsense')).toBeNull();
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

  it('uses the smiles once they load', async () => {
    // The success half of the same call: the map has to reach the parser, or
    // every :key: stays as text with nobody the wiser.
    const goodgameSmiles = vi.fn().mockResolvedValue(
      new Map([['peka', { url: 'https://gg/peka.png' }]]),
    );
    const h = harness({ assets: { goodgameSmiles, twitchThirdParty: vi.fn(), twitchBadges: vi.fn() } });
    await h.source.connect();
    await new Promise((r) => setTimeout(r, 0));

    h.socket().onmessage?.({
      data: JSON.stringify({
        type: 'message',
        data: { channel_id: '138653', message_id: 'm1', user_name: 'n', text: 'hi :peka:' },
      }),
    });
    expect(h.messages.at(-1)?.parts).toContainEqual({
      type: 'emote', url: 'https://gg/peka.png', name: 'peka',
    });
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

  it('removes a banned user by name, in this channel only', () => {
    const h = connected();
    h.source.handle({ type: 'ban', data: { user_name: 'BadUser' } });
    expect(h.removals).toEqual([
      { platform: 'goodgame', channel: 'annieflowers', user: 'baduser' },
    ]);
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
