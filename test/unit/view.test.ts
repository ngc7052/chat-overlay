import { describe, expect, it } from 'vitest';
import { normaliseConfig } from '../../src/main/config.js';
import type { Config } from '../../src/main/types.js';
import type { Badge, ChatMessage, ConnectionState } from '../../src/renderer/sources/types.js';
import {
  appearanceVars, badgeIconPath, badgeRendering, emptyHint, messagesToRemove, nameSeparator,
  paidChip, PIN_SLACK_PX, pinnedToBottom, platformIconPath, platformMarker, platformTag, barAlert,
  plainText, shouldDrop, sourceDotClass, statusDots, visibleBadges,
} from '../../src/renderer/view.js';

const config = (over: Partial<Config> = {}): Config => normaliseConfig(over);

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'x',
  platform: 'twitch',
  channel: 'xqc',
  user: 'Nero',
  userLogin: 'nero',
  color: '#fff',
  badges: [],
  parts: [{ type: 'text', value: 'hello' }],
  kind: 'chat',
  ts: 0,
  ...over,
});

describe('plainText', () => {
  it('ignores emotes when reading the message', () => {
    expect(plainText(message({
      parts: [
        { type: 'text', value: '!drop ' },
        { type: 'emote', url: 'u', name: 'Kappa' },
      ],
    }))).toBe('!drop');
  });
});

describe('shouldDrop', () => {
  it('keeps ordinary chat', () => {
    expect(shouldDrop(message(), config())).toBe(false);
  });

  it('hides commands only when asked', () => {
    const msg = message({ parts: [{ type: 'text', value: '!lastseen' }] });
    expect(shouldDrop(msg, config())).toBe(false);
    expect(shouldDrop(msg, config({ hideCommands: true }))).toBe(true);
  });

  it('drops ignored users case-insensitively', () => {
    const cfg = config({ ignoreList: ['BotName'] });
    expect(shouldDrop(message({ userLogin: 'botname' }), cfg)).toBe(true);
    expect(shouldDrop(message({ userLogin: 'someone' }), cfg)).toBe(false);
  });

  it('ignores blank entries in the ignore list', () => {
    expect(shouldDrop(message({ userLogin: '' }), config({ ignoreList: [''] }))).toBe(false);
  });

  it('hides connection notices when the user turned them off', () => {
    const sys = message({ kind: 'system', channel: 'xqc' });
    expect(shouldDrop(sys, config())).toBe(false);
    expect(shouldDrop(sys, config({ showSystem: false }))).toBe(true);
  });

  it('always shows the hint that has no channel', () => {
    // Hiding this would leave a new user staring at an empty window.
    const hint = message({ kind: 'system', channel: '' });
    expect(shouldDrop(hint, config({ showSystem: false }))).toBe(false);
  });
});

describe('platformMarker', () => {
  it('follows the setting', () => {
    expect(platformMarker(message(), config({ platformStyle: 'icon' }))).toBe('icon');
    expect(platformMarker(message(), config({ platformStyle: 'text' }))).toBe('text');
    expect(platformMarker(message(), config({ platformStyle: 'off' }))).toBe('none');
  });

  it('shows nothing for a message with no channel', () => {
    expect(platformMarker(message({ channel: '' }), config())).toBe('none');
  });
});

describe('platformIconPath', () => {
  it('picks the right logo', () => {
    expect(platformIconPath('twitch')).toContain('twitch.svg');
    expect(platformIconPath('goodgame')).toContain('goodgame.png');
  });
});

describe('badges', () => {
  const withArt: Badge = { kind: 'sub', label: 'SUB', url: 'https://cdn/x', title: 'Sub' };
  const withoutArt: Badge = { kind: 'mod', label: 'MOD', url: null, title: 'Mod' };
  const ytMod: Badge = { kind: 'moderator', label: 'MOD', url: null, title: 'Moderator' };
  const ggHost: Badge = { kind: 'broadcaster', label: 'HOST', url: null, title: 'HOST' };

  it('draws artwork only when there is artwork and icons are on', () => {
    expect(badgeRendering(withArt, config({ badgeStyle: 'icons' }))).toBe('image');
    expect(badgeRendering(withoutArt, config({ badgeStyle: 'icons' }))).toBe('chip');
    expect(badgeRendering(withArt, config({ badgeStyle: 'text' }))).toBe('chip');
  });

  it('falls back to the bundled artwork for a role nobody sent a picture of', () => {
    // YouTube and GoodGame name the role and send no image. Without this they
    // drew the letters MOD beside a Twitch sword meaning the same thing.
    expect(badgeIconPath(ytMod)).toContain('badge-moderator.svg');
    expect(badgeIconPath(ggHost)).toContain('badge-broadcaster.svg');
    expect(badgeRendering(ytMod, config({ badgeStyle: 'icons' }))).toBe('image');
    expect(badgeRendering(ggHost, config({ badgeStyle: 'icons' }))).toBe('image');
  });

  it("prefers the platform's own artwork over the bundled icon", () => {
    // Twitch publishes both roles itself, and its picture is the authority.
    const twitchMod: Badge = { kind: 'moderator', label: 'MOD', url: 'https://cdn/mod', title: 'Mod' };
    expect(badgeIconPath(twitchMod)).toBe('https://cdn/mod');
  });

  it('has artwork for no other url-less kind', () => {
    // GoodGame's ADMIN and YouTube's VER have no counterpart to match, so they
    // stay chips rather than borrowing a symbol that means something else.
    expect(badgeIconPath({ kind: 'staff', label: 'ADMIN', url: null, title: 'ADMIN' })).toBeNull();
    expect(badgeIconPath({ kind: 'premium', label: 'VER', url: null, title: 'Verified' })).toBeNull();
  });

  it('still draws a text chip for a role when the user asked for text', () => {
    // badgeStyle is a choice, not a capability check: someone who picked text
    // gets text for the roles we do have artwork for, and nothing when off.
    expect(badgeRendering(ytMod, config({ badgeStyle: 'text' }))).toBe('chip');
    expect(badgeRendering(ggHost, config({ badgeStyle: 'text' }))).toBe('chip');
    expect(visibleBadges(message({ badges: [ytMod, ggHost] }), config({ badgeStyle: 'off' })))
      .toEqual([]);
  });

  it('draws a GoodGame icon as an image like any other badge', () => {
    // These are white monochrome SVGs, so an <img> renders them correctly.
    const ggIcon: Badge = { kind: 'gg-icon', label: 'STAR', url: 'https://x/s.svg', title: 'star' };
    expect(badgeRendering(ggIcon, config({ badgeStyle: 'icons' }))).toBe('image');
  });

  it('hides badges entirely when switched off', () => {
    const msg = message({ badges: [withArt] });
    expect(visibleBadges(msg, config({ badgeStyle: 'off' }))).toEqual([]);
    expect(visibleBadges(msg, config())).toEqual([withArt]);
  });

  it('never puts badges on a system line', () => {
    expect(visibleBadges(message({ kind: 'system', badges: [withArt] }), config())).toEqual([]);
  });
});

describe('appearanceVars', () => {
  it('derives the sizes from the font size', () => {
    const vars = appearanceVars(config({ fontSize: 20, emoteScale: 2 }));
    expect(vars['--font-size']).toBe('20px');
    expect(vars['--emote-size']).toBe('40px');
    expect(vars['--badge-size']).toBe('23px');
  });

  it('only bolds names when asked', () => {
    expect(appearanceVars(config({ boldNames: true }))['--name-weight']).toBe('800');
    expect(appearanceVars(config({ boldNames: false }))['--name-weight']).toBe('var(--font-weight)');
  });

  it('renders the backdrop as an alpha colour', () => {
    expect(appearanceVars(config({ bgOpacity: 0.5 }))['--bg']).toBe('rgba(10, 12, 18, 0.5)');
  });

  it('exposes a second backdrop for the unlocked hover state', () => {
    // Locked shows only text; hovering while unlocked has to reveal the window
    // edges, so the two backdrops are independent.
    const vars = appearanceVars(config({ bgOpacity: 0, hoverBgOpacity: 0.6 }));
    expect(vars['--bg']).toBe('rgba(10, 12, 18, 0)');
    expect(vars['--bg-hover']).toBe('rgba(10, 12, 18, 0.6)');
  });
});

describe('statusDots', () => {
  const sources = [
    { key: 'twitch:xqc', platform: 'twitch', channel: 'xqc' },
    { key: 'goodgame:ann', platform: 'goodgame', channel: 'ann' },
  ];

  it('shows nothing when no channel is configured', () => {
    // The chat body carries the "add one" hint; the bar stays empty.
    expect(statusDots([], new Map())).toEqual([]);
  });

  it('carries one dot per source, in its state', () => {
    const states = new Map([
      ['twitch:xqc', { state: 'online' as const, detail: '' }],
      ['goodgame:ann', { state: 'error' as const, detail: 'boom' }],
    ]);
    expect(statusDots(sources, states)).toEqual([
      { key: 'twitch:xqc', label: 'tw/xqc', state: 'online', title: 'tw/xqc — online' },
      { key: 'goodgame:ann', label: 'gg/ann', state: 'error', title: 'gg/ann — error — boom' },
    ]);
  });

  it('puts the retry detail in the tooltip while reconnecting', () => {
    const states = new Map([['twitch:xqc', { state: 'connecting' as const, detail: 'retry in 3s' }]]);
    expect(statusDots([sources[0]!], states)[0]?.title).toBe('tw/xqc — connecting — retry in 3s');
  });

  it('drops the detail once online, where it is no longer a problem', () => {
    const states = new Map([['twitch:xqc', { state: 'online' as const, detail: 'stream title' }]]);
    expect(statusDots([sources[0]!], states)[0]?.title).toBe('tw/xqc — online');
  });

  it('assumes connecting for a source with no state yet', () => {
    expect(statusDots([sources[0]!], new Map())[0])
      .toEqual({ key: 'twitch:xqc', label: 'tw/xqc', state: 'connecting', title: 'tw/xqc — connecting' });
  });
});

describe('barAlert', () => {
  const dot = (key: string, state: ConnectionState) =>
    ({ key, label: key, state, title: key + ' — ' + state });

  it('says nothing at all while every channel is connected', () => {
    // The healthy answer is silence: the arriving messages already prove it,
    // and a permanent green light over a game buys nothing.
    expect(barAlert([dot('tw/a', 'online'), dot('gg/b', 'online')]))
      .toEqual({ level: 'ok', text: '', title: 'tw/a — online\ngg/b — online' });
  });

  it('says nothing when no channel is configured', () => {
    // An empty list is legitimate; the hint in the chat body covers it.
    expect(barAlert([])).toEqual({ level: 'ok', text: '', title: '' });
  });

  it('counts the ones that are down while the rest still carry chat', () => {
    expect(barAlert([dot('tw/a', 'online'), dot('gg/b', 'connecting')]))
      .toMatchObject({ level: 'warn', text: '1 of 2 offline' });
    expect(barAlert([dot('tw/a', 'online'), dot('gg/b', 'error'), dot('tw/c', 'offline')]))
      .toMatchObject({ level: 'warn', text: '2 of 3 offline' });
  });

  it('separates "some of it stopped" from "all of it stopped"', () => {
    // Different problems: with one channel still talking there is nothing to
    // do, and with none the feed has frozen — which is the question a user
    // actually asks when chat goes quiet.
    expect(barAlert([dot('tw/a', 'offline'), dot('gg/b', 'connecting')]))
      .toMatchObject({ level: 'down', text: 'all channels offline' });
  });

  it('does not count channels when there is only one', () => {
    expect(barAlert([dot('tw/a', 'error')])).toMatchObject({ level: 'down', text: 'offline' });
  });

  /**
   * A YouTube channel that is not streaming is the ordinary resting state of
   * most channels, not a fault — and painting "1 of 2 offline" over a game for
   * the five evenings a week somebody does not stream is exactly the permanent
   * alert this design exists to avoid.
   */
  it('says nothing about a channel that is simply not live', () => {
    expect(barAlert([dot('tw/a', 'online'), dot('yt/b', 'idle')]))
      .toMatchObject({ level: 'ok', text: '' });
    expect(barAlert([dot('yt/b', 'idle')])).toMatchObject({ level: 'ok', text: '' });
  });

  it('still counts the channels that really are down beside it', () => {
    expect(barAlert([dot('tw/a', 'online'), dot('gg/b', 'offline'), dot('yt/c', 'idle')]))
      .toMatchObject({ level: 'warn', text: '1 of 3 offline' });
    // Every channel that could be carrying chat has stopped; the one that is
    // not live was never going to be.
    expect(barAlert([dot('gg/b', 'offline'), dot('yt/c', 'idle')]))
      .toMatchObject({ level: 'down', text: 'all channels offline' });
  });

  it('carries every channel state in the tooltip', () => {
    expect(barAlert([dot('tw/a', 'online'), dot('gg/b', 'error')]).title)
      .toBe('tw/a — online\ngg/b — error');
  });
});

describe('emptyHint', () => {
  it('distinguishes "none added" from "none enabled"', () => {
    expect(emptyHint([])).toContain('No channels yet');
    expect(emptyHint([{ platform: 'twitch', channel: '', enabled: true }])).toContain('No channels yet');
    expect(emptyHint([{ platform: 'twitch', channel: 'x', enabled: false }])).toContain('No channel enabled');
  });
});

describe('sourceDotClass', () => {
  const src = { platform: 'twitch' as const, channel: 'x', enabled: true };

  it('greys out a disabled row', () => {
    expect(sourceDotClass({ ...src, enabled: false }, { state: 'online', detail: '' })).toBe('dot');
  });

  it('reflects the connection state', () => {
    expect(sourceDotClass(src, { state: 'online', detail: '' })).toBe('dot on');
    expect(sourceDotClass(src, { state: 'error', detail: '' })).toBe('dot err');
    expect(sourceDotClass(src, { state: 'connecting', detail: '' })).toBe('dot');
    expect(sourceDotClass(src, undefined)).toBe('dot');
  });

  it('handles a missing row', () => {
    expect(sourceDotClass(undefined, undefined)).toBe('dot');
  });
});

describe('messagesToRemove', () => {
  const rendered = [
    { id: 'a', platform: 'twitch', channel: 'xqc', user: 'nero' },
    { id: 'b', platform: 'twitch', channel: 'xqc', user: 'other' },
    { id: 'c', platform: 'goodgame', channel: 'ann', user: 'nero' },
  ];

  /**
   * YouTube names a banned author by channel id, and that is the only unique
   * thing about them: display names are freely reusable, and copying a
   * regular's name is routine in a large chat. Matching on the name would take
   * the person being impersonated down with the impersonator.
   */
  it('removes by author id without touching an impostor of the same name', () => {
    const sameName = [
      { id: 'a', platform: 'youtube', channel: 'ch', user: 'regular', userId: 'UCreal' },
      { id: 'b', platform: 'youtube', channel: 'ch', user: 'regular', userId: 'UCtroll' },
    ];
    expect(messagesToRemove({ platform: 'youtube', channel: 'ch', userId: 'UCtroll' }, sameName))
      .toEqual(['b']);
  });

  it('removes nothing for an author id nothing on screen carries', () => {
    expect(messagesToRemove({ platform: 'youtube', channel: 'ch', userId: 'UCnever' }, [
      { id: 'a', platform: 'youtube', channel: 'ch', user: 'regular', userId: 'UCreal' },
    ])).toEqual([]);
  });

  it('keeps a ban inside the channel it was issued in, by id as well', () => {
    expect(messagesToRemove({ platform: 'youtube', channel: 'one', userId: 'UCx' }, [
      { id: 'a', platform: 'youtube', channel: 'one', user: 'bob', userId: 'UCx' },
      { id: 'b', platform: 'youtube', channel: 'two', user: 'bob', userId: 'UCx' },
    ])).toEqual(['a']);
  });

  it('passes explicit ids straight through', () => {
    expect(messagesToRemove({ ids: ['a', 'zzz'] }, rendered)).toEqual(['a', 'zzz']);
  });

  it('removes one user on one platform only', () => {
    expect(messagesToRemove({ platform: 'twitch', channel: 'xqc', user: 'nero' }, rendered))
      .toEqual(['a']);
  });

  // Watching several channels at once is the point of the app, and a timeout is
  // issued by one channel's moderators. It must not follow the user into a
  // channel where nobody moderated them.
  it('leaves the same user alone in another channel of the same platform', () => {
    const bothChannels = [
      { id: 'a', platform: 'twitch', channel: 'chan_one', user: 'bob' },
      { id: 'b', platform: 'twitch', channel: 'chan_two', user: 'bob' },
    ];
    expect(messagesToRemove({ platform: 'twitch', channel: 'chan_one', user: 'bob' }, bothChannels))
      .toEqual(['a']);
  });

  it('clears a whole channel', () => {
    expect(messagesToRemove({ platform: 'twitch', channel: 'xqc', all: true }, rendered))
      .toEqual(['a', 'b']);
  });

  it('removes nothing for a request that targets nothing', () => {
    expect(messagesToRemove({}, rendered)).toEqual([]);
  });
});

describe('platform artwork and tags', () => {
  it('names the icon and the two-letter tag for each platform', () => {
    expect(platformIconPath('twitch')).toBe('../assets/twitch.svg');
    expect(platformIconPath('youtube')).toBe('../assets/youtube.svg');
    expect(platformIconPath('goodgame')).toBe('../assets/goodgame.png');
    expect(platformTag('twitch')).toBe('tw');
    expect(platformTag('youtube')).toBe('yt');
    expect(platformTag('goodgame')).toBe('gg');
  });

  /** A config file is hand-editable, so a platform nobody has heard of can arrive. */
  it('falls back rather than rendering a blank marker', () => {
    expect(platformIconPath('mystery')).toBe('../assets/goodgame.png');
    expect(platformTag('mystery')).toBe('gg');
  });
});

describe('pinnedToBottom', () => {
  // The feed follows new messages only for someone who is already at the end
  // of it. Someone who has scrolled back to read something must be left where
  // they are — being yanked to the bottom mid-sentence every time a busy
  // channel says anything makes the overlay unreadable.
  const view = (fromBottom: number) => ({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 - fromBottom });

  it('follows the feed for someone sitting at the bottom', () => {
    expect(pinnedToBottom(view(0))).toBe(true);
  });

  it('still follows within the slack, so a fractional scroll does not stop it', () => {
    expect(pinnedToBottom(view(PIN_SLACK_PX - 1))).toBe(true);
  });

  it('lets go the moment someone has scrolled up past it', () => {
    expect(pinnedToBottom(view(PIN_SLACK_PX))).toBe(false);
    expect(pinnedToBottom(view(300))).toBe(false);
  });

  it('follows a feed too short to scroll at all', () => {
    expect(pinnedToBottom({ scrollHeight: 200, clientHeight: 400, scrollTop: 0 })).toBe(true);
  });
});

describe('nameSeparator', () => {
  it('is a colon before something the author said', () => {
    expect(nameSeparator(message())).toBe(':');
  });

  it('is a space before something that happened to them', () => {
    // A /me, and every membership event: the line reads as a sentence.
    expect(nameSeparator(message({ action: true }))).toBe(' ');
  });

  it('is nothing at all when there is nothing after it', () => {
    // A superchat sent with no message, which is ordinary — a dangling colon
    // is the one thing on screen that would look like a bug rather than a tip.
    expect(nameSeparator(message({ parts: [] }))).toBe('');
  });
});

describe('paidChip', () => {
  it('is nothing on an ordinary message', () => {
    expect(paidChip(message())).toBeNull();
  });

  it('carries the amount as text, in the platform\'s own tier colours', () => {
    expect(paidChip(message({
      paid: { amount: '¥5,000', swatch: { bg: 'rgb(194, 24, 91)', ink: '#ffffff' } },
    }))).toEqual({ text: '¥5,000', bg: 'rgb(194, 24, 91)', ink: '#ffffff' });
  });

  it('still says the amount when no tier colour came with it', () => {
    // Colour is the redundant channel here; the amount is the message, so a
    // missing colour must never be what stops it being drawn.
    expect(paidChip(message({ paid: { amount: '$2.00', swatch: null } })))
      .toEqual({ text: '$2.00', bg: '#55607a', ink: '#ffffff' });
  });

  it('draws no chip when there is no amount to put in it', () => {
    expect(paidChip(message({ paid: { amount: '   ', swatch: null } }))).toBeNull();
  });
});
