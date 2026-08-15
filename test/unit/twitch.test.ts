import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBadges, TwitchSource, twitchEmoteUrl } from '../../src/renderer/sources/twitch.js';
import type { ChatMessage, RemoveRequest, SocketLike, SourceOptions } from '../../src/renderer/sources/types.js';

/** A socket that records what was sent and lets the test drive the callbacks. */
class FakeSocket implements SocketLike {
  readyState = 1;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
}

interface Harness {
  source: TwitchSource;
  socket: FakeSocket;
  messages: ChatMessage[];
  removals: RemoveRequest[];
  statuses: { state: string; detail: string }[];
  timers: { fn: () => void; ms: number }[];
  warnings: string[];
}

function harness(overrides: Partial<SourceOptions> = {}): Harness {
  const messages: ChatMessage[] = [];
  const removals: RemoveRequest[] = [];
  const statuses: { state: string; detail: string }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const warnings: string[] = [];
  let socket!: FakeSocket;

  const source = new TwitchSource({
    channel: 'Xqc',
    onMessage: (m) => messages.push(m),
    onRemove: (r) => removals.push(r),
    onStatus: (_s, state, detail) => statuses.push({ state, detail }),
    getConfig: () => ({ emotes: true, thirdPartyEmotes: true, exactColors: false }),
    createSocket: () => { socket = new FakeSocket(); return socket; },
    setTimeoutFn: (fn, ms) => { timers.push({ fn: fn as () => void, ms }); return timers.length; },
    clearTimeoutFn: () => {},
    random: () => 0.5,
    now: () => 1_700_000_000_000,
    onWarn: (m) => warnings.push(m),
    ...overrides,
  });

  source.connect();
  return { source, socket: socket!, messages, removals, statuses, timers, warnings };
}

describe('twitchEmoteUrl', () => {
  it('points at the v2 CDN in dark 2.0', () => {
    expect(twitchEmoteUrl('25')).toBe(
      'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0',
    );
  });
});

describe('buildBadges', () => {
  const art = new Map([['subscriber/24', { url: 'https://cdn/sub24', title: 'Subscriber' }]]);

  it('uses artwork when the catalogue has it', () => {
    const [badge] = buildBadges('subscriber/24', '', art);
    expect(badge).toMatchObject({ kind: 'subscriber', label: 'SUB', url: 'https://cdn/sub24' });
  });

  it('falls back to a text chip when the catalogue does not', () => {
    const [badge] = buildBadges('moderator/1', '', new Map());
    expect(badge).toMatchObject({ kind: 'moderator', label: 'MOD', url: null });
  });

  it('appends the real tenure from badge-info', () => {
    const [badge] = buildBadges('subscriber/24', 'subscriber/27', art);
    expect(badge?.title).toBe('Subscriber (27)');
  });

  it('invents a label for an unknown badge set', () => {
    const [badge] = buildBadges('glhf-pledge/1', '', new Map());
    expect(badge).toMatchObject({ kind: 'generic', label: 'GLHF' });
  });

  it('defaults a missing version to 1', () => {
    const map = new Map([['vip/1', { url: 'u', title: 'VIP' }]]);
    expect(buildBadges('vip', '', map)[0]?.url).toBe('u');
  });

  it('ignores empty tags and caps the count', () => {
    expect(buildBadges('', '', new Map())).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => `set${i}/1`).join(',');
    expect(buildBadges(many, '', new Map())).toHaveLength(8);
  });
});

describe('TwitchSource connection', () => {
  it('logs in anonymously and joins the channel in lowercase', () => {
    const h = harness();
    h.socket.onopen?.();
    expect(h.socket.sent).toEqual([
      'CAP REQ :twitch.tv/tags twitch.tv/commands',
      'PASS SCHMOOPIIE',
      'NICK justinfan50000',
      'JOIN #xqc',
    ]);
  });

  it('strips a leading # from the configured channel', () => {
    const h = harness({ channel: '#XQC' });
    expect(h.source.channel).toBe('xqc');
  });

  it('answers PING with PONG so the connection is not dropped', () => {
    const h = harness();
    h.socket.onopen?.();
    h.socket.sent.length = 0;
    h.socket.onmessage?.({ data: 'PING :tmi.twitch.tv\r\n' });
    expect(h.socket.sent).toEqual(['PONG :tmi.twitch.tv']);
  });

  it('defaults the PONG target when PING carries none', () => {
    const h = harness();
    h.socket.onopen?.();
    h.socket.sent.length = 0;
    h.socket.onmessage?.({ data: 'PING' });
    expect(h.socket.sent).toEqual(['PONG :tmi.twitch.tv']);
  });

  it('sends a keepalive PING when the timer fires', () => {
    const h = harness();
    h.socket.onopen?.();
    h.socket.sent.length = 0;
    const keepalive = h.timers[h.timers.length - 1];
    keepalive?.fn();
    expect(h.socket.sent).toEqual(['PING :overlay']);
  });

  it('retries with backoff after the socket closes', () => {
    const h = harness();
    h.socket.onclose?.();
    expect(h.statuses.map((s) => s.state)).toContain('offline');
    const retry = h.statuses.find((s) => s.detail.startsWith('retry in'));
    expect(retry).toBeDefined();
  });

  it('ignores a close from a socket that is no longer current', () => {
    const h = harness();
    const stale = h.socket;
    h.source.connect();       // replaces the socket
    h.statuses.length = 0;
    stale.onclose?.();
    expect(h.statuses).toEqual([]);
  });

  it('reports socket errors', () => {
    const h = harness();
    h.socket.onerror?.();
    expect(h.statuses.some((s) => s.state === 'error' && s.detail === 'socket error')).toBe(true);
  });

  it('reconnects when the server asks', () => {
    const h = harness();
    h.socket.onmessage?.({ data: 'RECONNECT' });
    expect(h.statuses.some((s) => s.detail === 'server asked to reconnect')).toBe(true);
  });

  it('does nothing once destroyed', () => {
    const h = harness();
    h.source.destroy();
    h.statuses.length = 0;
    h.source.connect();
    expect(h.statuses).toEqual([]);
  });

  it('reports online on welcome', () => {
    const h = harness();
    h.socket.onmessage?.({ data: ':tmi.twitch.tv 001 justinfan1 :Welcome, GLHF!' });
    expect(h.statuses.some((s) => s.state === 'online')).toBe(true);
  });

  it('ignores commands it does not handle', () => {
    const h = harness();
    const before = h.messages.length;
    h.socket.onmessage?.({ data: ':tmi.twitch.tv 366 justinfan1 #xqc :End of /NAMES list' });
    expect(h.messages).toHaveLength(before);
  });
});

describe('TwitchSource events', () => {
  it('announces the connection once ROOMSTATE arrives', () => {
    const h = harness();
    h.socket.onmessage?.({ data: '@room-id=71092938 :tmi.twitch.tv ROOMSTATE #xqc' });
    expect(h.source.roomId).toBe('71092938');
    expect(h.messages.at(-1)?.parts[0]).toEqual({ type: 'text', value: 'connected — twitch/xqc' });
  });

  it('does not re-announce for an unchanged room id', () => {
    const h = harness();
    h.socket.onmessage?.({ data: '@room-id=1 :tmi.twitch.tv ROOMSTATE #xqc' });
    const count = h.messages.length;
    h.socket.onmessage?.({ data: '@room-id=1 :tmi.twitch.tv ROOMSTATE #xqc' });
    expect(h.messages).toHaveLength(count);
  });

  it('turns a timeout into a per-user removal', () => {
    const h = harness();
    h.socket.onmessage?.({ data: ':tmi.twitch.tv CLEARCHAT #xqc :BadUser' });
    expect(h.removals).toEqual([{ platform: 'twitch', user: 'baduser' }]);
  });

  it('turns a full clear into a channel removal', () => {
    const h = harness();
    h.socket.onmessage?.({ data: ':tmi.twitch.tv CLEARCHAT #xqc' });
    expect(h.removals).toEqual([{ platform: 'twitch', channel: 'xqc', all: true }]);
  });

  it('removes a single deleted message by id', () => {
    const h = harness();
    h.socket.onmessage?.({ data: '@target-msg-id=abc :tmi.twitch.tv CLEARMSG #xqc :text' });
    expect(h.removals).toEqual([{ ids: ['twitch:xqc:abc'] }]);
  });

  it('ignores CLEARMSG without a target', () => {
    const h = harness();
    h.socket.onmessage?.({ data: ':tmi.twitch.tv CLEARMSG #xqc :text' });
    expect(h.removals).toEqual([]);
  });

  it('shows sub notifications as events', () => {
    const h = harness();
    h.socket.onmessage?.({ data: '@system-msg=Nero\\ssubscribed! :tmi.twitch.tv USERNOTICE #xqc' });
    expect(h.messages.at(-1)).toMatchObject({ kind: 'event' });
    expect(h.messages.at(-1)?.parts[0]).toEqual({ type: 'text', value: 'Nero subscribed!' });
  });

  it('ignores a USERNOTICE with no system message', () => {
    const h = harness();
    const before = h.messages.length;
    h.socket.onmessage?.({ data: ':tmi.twitch.tv USERNOTICE #xqc' });
    expect(h.messages).toHaveLength(before);
  });

  it('surfaces NOTICE text and flags the failure kinds', () => {
    const h = harness();
    h.socket.onmessage?.({ data: ':tmi.twitch.tv NOTICE #xqc :No such channel' });
    expect(h.statuses.some((s) => s.state === 'error')).toBe(true);
    h.socket.onmessage?.({ data: ':tmi.twitch.tv NOTICE #xqc :Now hosting' });
    expect(h.messages.at(-1)?.kind).toBe('system');
  });
});

describe('TwitchSource message building', () => {
  it('builds a chat message from the tags', () => {
    const h = harness();
    h.socket.onmessage?.({
      data: '@id=m1;display-name=K_u_p;color=#FF0000;user-id=9;tmi-sent-ts=1700000000000 ' +
        ':k_u_p!k@k PRIVMSG #xqc :hello',
    });
    expect(h.messages.at(-1)).toMatchObject({
      id: 'twitch:xqc:m1',
      platform: 'twitch',
      user: 'K_u_p',
      userLogin: 'k_u_p',
      userId: '9',
      kind: 'chat',
      ts: 1700000000000,
    });
  });

  it('falls back to the login when there is no display name', () => {
    const h = harness();
    h.socket.onmessage?.({ data: ':someone!s@s PRIVMSG #xqc :hi' });
    expect(h.messages.at(-1)?.user).toBe('someone');
  });

  it('uses the display name when the prefix is missing', () => {
    const h = harness();
    h.socket.onmessage?.({ data: '@display-name=Solo PRIVMSG #xqc :hi' });
    expect(h.messages.at(-1)?.userLogin).toBe('solo');
  });

  it('generates an id and timestamp when the tags omit them', () => {
    const h = harness();
    h.socket.onmessage?.({ data: ':a!a@a PRIVMSG #xqc :hi' });
    expect(h.messages.at(-1)?.id).toMatch(/^twitch:xqc:/);
    expect(h.messages.at(-1)?.ts).toBe(1_700_000_000_000);
  });

  it('detects /me and strips the CTCP delimiters', () => {
    const h = harness();
    h.socket.onmessage?.({ data: ':a!a@a PRIVMSG #xqc :ACTION waves' });
    const msg = h.messages.at(-1);
    expect(msg?.action).toBe(true);
    expect(msg?.parts).toEqual([{ type: 'text', value: 'waves' }]);
  });

  it('uses the exact colour when configured to', () => {
    const h = harness({
      getConfig: () => ({ emotes: true, thirdPartyEmotes: true, exactColors: true }),
    });
    h.socket.onmessage?.({ data: '@color=#0000FF :a!a@a PRIVMSG #xqc :hi' });
    expect(h.messages.at(-1)?.color).toBe('#0000ff');
  });
});

describe('TwitchSource.buildParts', () => {
  let source: TwitchSource;

  beforeEach(() => {
    source = harness().source;
  });

  it('replaces native emote ranges', () => {
    expect(source.buildParts('Kappa hey Kappa', '25:0-4,10-14')).toEqual([
      { type: 'emote', url: twitchEmoteUrl('25'), name: 'Kappa' },
      { type: 'text', value: ' hey ' },
      { type: 'emote', url: twitchEmoteUrl('25'), name: 'Kappa' },
    ]);
  });

  it('indexes by code point, not UTF-16 unit', () => {
    // A surrogate pair earlier in the line shifts every later UTF-16 index;
    // getting this wrong slices the emote name one character short.
    expect(source.buildParts('\u{1F438} Kappa', '25:2-6')).toEqual([
      { type: 'text', value: '\u{1F438} ' },
      { type: 'emote', url: twitchEmoteUrl('25'), name: 'Kappa' },
    ]);
  });

  it('ignores ranges that fall outside the text', () => {
    expect(source.buildParts('hi', '25:0-99')).toEqual([{ type: 'text', value: 'hi' }]);
    expect(source.buildParts('hi', '25:5-6')).toEqual([{ type: 'text', value: 'hi' }]);
    expect(source.buildParts('hi', '25:1-0')).toEqual([{ type: 'text', value: 'hi' }]);
  });

  it('ignores malformed emote tags', () => {
    expect(source.buildParts('hi', 'garbage')).toEqual([{ type: 'text', value: 'hi' }]);
    expect(source.buildParts('hi', '25:x-y')).toEqual([{ type: 'text', value: 'hi' }]);
  });

  it('substitutes third-party emotes by whole word only', () => {
    source.emoteMap = new Map([['PagMan', { url: 'https://cdn/pagman' }]]);
    expect(source.buildParts('lol PagMan lol', '')).toEqual([
      { type: 'text', value: 'lol ' },
      { type: 'emote', url: 'https://cdn/pagman', name: 'PagMan' },
      { type: 'text', value: ' lol' },
    ]);
    expect(source.buildParts('xPagManx', '')).toEqual([{ type: 'text', value: 'xPagManx' }]);
  });

  it('keeps urls intact alongside emotes', () => {
    source.emoteMap = new Map([['PagMan', { url: 'https://cdn/pagman' }]]);
    const parts = source.buildParts('see https://a.b/c PagMan', '');
    expect(parts).toContainEqual({ type: 'url', value: 'https://a.b/c' });
    expect(parts).toContainEqual({ type: 'emote', url: 'https://cdn/pagman', name: 'PagMan' });
  });

  it('returns plain text when emotes are switched off', () => {
    const off = harness({
      getConfig: () => ({ emotes: false, thirdPartyEmotes: true, exactColors: false }),
    }).source;
    off.emoteMap = new Map([['PagMan', { url: 'u' }]]);
    expect(off.buildParts('PagMan', '25:0-5')).toEqual([{ type: 'text', value: 'PagMan' }]);
  });

  it('skips the word scan when third-party emotes are off', () => {
    const off = harness({
      getConfig: () => ({ emotes: true, thirdPartyEmotes: false, exactColors: false }),
    }).source;
    off.emoteMap = new Map([['PagMan', { url: 'u' }]]);
    expect(off.buildParts('PagMan', '')).toEqual([{ type: 'text', value: 'PagMan' }]);
  });
});

describe('TwitchSource.loadAssets', () => {
  it('loads emotes and badges once the room id is known', async () => {
    const twitchThirdParty = vi.fn().mockResolvedValue(new Map([['a', { url: 'u' }]]));
    const twitchBadges = vi.fn().mockResolvedValue(new Map([['b/1', { url: 'u', title: 't' }]]));
    const h = harness({
      assets: { twitchThirdParty, twitchBadges, goodgameSmiles: vi.fn() },
    });
    h.source.roomId = '42';
    await h.source.loadAssets();
    expect(twitchThirdParty).toHaveBeenCalledWith('42');
    expect(twitchBadges).toHaveBeenCalledWith('42');
    expect(h.source.emoteMap.size).toBe(1);
    expect(h.source.badgeMap.size).toBe(1);
  });

  it('skips third-party emotes when they are switched off', async () => {
    const twitchThirdParty = vi.fn();
    const h = harness({
      getConfig: () => ({ emotes: true, thirdPartyEmotes: false, exactColors: false }),
      assets: { twitchThirdParty, twitchBadges: vi.fn().mockResolvedValue(new Map()), goodgameSmiles: vi.fn() },
    });
    h.source.roomId = '42';
    await h.source.loadAssets();
    expect(twitchThirdParty).not.toHaveBeenCalled();
  });

  it('warns but carries on when a catalogue fails', async () => {
    const h = harness({
      assets: {
        twitchThirdParty: vi.fn().mockRejectedValue(new Error('offline')),
        twitchBadges: vi.fn().mockRejectedValue(new Error('down')),
        goodgameSmiles: vi.fn(),
      },
    });
    h.source.roomId = '42';
    await h.source.loadAssets();
    expect(h.warnings).toEqual([
      'twitch 3rd-party emotes failed: offline',
      'twitch badges failed: down',
    ]);
  });

  it('does nothing without a room id or an asset api', async () => {
    const h = harness();
    await expect(h.source.loadAssets()).resolves.toBeUndefined();
  });
});
