import { describe, expect, it } from 'vitest';
import { PROBE_GRACE_MS } from '../../src/renderer/sources/base.js';
import { YT_CHAT_POLL_URL } from '../../src/renderer/sources/innertube.js';
import {
  YouTubeSource, YT_IDLE_MS, YT_NOT_LIVE_MS, ytBadges, ytBody, ytItemKind, ytParts, ytText,
} from '../../src/renderer/sources/youtube.js';
import type { ChatMessage, RemoveRequest, SourceOptions } from '../../src/renderer/sources/types.js';

/* ------------------------------------------------------------------ fixtures */

const chatPage = (over: Record<string, unknown> = {}, version = '2.20260817.01.00') =>
  `window["ytInitialData"] = ${JSON.stringify({
    contents: {
      liveChatRenderer: {
        continuations: [{ invalidationContinuationData: { continuation: 'TOP' } }],
        header: {
          liveChatHeaderRenderer: {
            viewSelector: {
              sortFilterSubMenuRenderer: {
                subMenuItems: [
                  { title: 'Top chat', selected: true, continuation: { reloadContinuationData: { continuation: 'TOP' } } },
                  { title: 'Live chat', continuation: { reloadContinuationData: { continuation: 'ALL' } } },
                ],
              },
            },
          },
        },
        ...over,
      },
    },
  })};"INNERTUBE_CLIENT_VERSION":"${version}"`;

const livePage = (videoId: string | null) =>
  `var ytInitialData = ${JSON.stringify(
    videoId ? { currentVideoEndpoint: { watchEndpoint: { videoId } } } : { contents: {} },
  )};</script>`;

const NO_CHAT = `window["ytInitialData"] = ${JSON.stringify({
  contents: { messageRenderer: { text: { runs: [{ text: 'Chat is disabled for this live stream.' }] } } },
})};"INNERTUBE_CLIENT_VERSION":"2.1"`;

function chatItem(text: string, over: Record<string, unknown> = {}) {
  return {
    addChatItemAction: {
      item: {
        liveChatTextMessageRenderer: {
          id: 'm-' + text.slice(0, 4),
          authorName: { simpleText: '@viewer' },
          authorExternalChannelId: 'UCabc',
          timestampUsec: '1700000000000000',
          message: { runs: [{ text }] },
          ...over,
        },
      },
    },
  };
}

/*
 * The item shapes below were read off live channels rather than invented — a
 * superchat parsed into an empty amount is worse than one that was skipped —
 * and are the same objects with the tracking, context menus and reply buttons
 * taken out. `headerBackgroundColor` really does arrive as an unsigned ARGB
 * integer: 4290910299 is 0xFFC2185B, the magenta of YouTube's ¥5,000 tier.
 */

/** A superchat. `message` is absent on the many that are sent with no text. */
function paidItem(amount: string, text?: string, over: Record<string, unknown> = {}) {
  return {
    addChatItemAction: {
      item: {
        liveChatPaidMessageRenderer: {
          id: 'sc-1',
          timestampUsec: '1700000000000000',
          authorName: { simpleText: '@bigspender' },
          authorExternalChannelId: 'UCpaid',
          purchaseAmountText: { simpleText: amount },
          headerBackgroundColor: 4290910299,
          headerTextColor: 4294967295,
          bodyBackgroundColor: 4293467747,
          ...(text === undefined ? {} : { message: { runs: [{ text }] } }),
          ...over,
        },
      },
    },
  };
}

/** A membership milestone, and — with `over` — a brand-new member. */
function memberItem(over: Record<string, unknown> = {}) {
  return {
    addChatItemAction: {
      item: {
        liveChatMembershipItemRenderer: {
          id: 'mem-1',
          timestampUsec: '1700000000000000',
          authorExternalChannelId: 'UCmember',
          authorName: { simpleText: '@regular' },
          headerPrimaryText: { runs: [{ text: 'Member for ' }, { text: '4' }, { text: ' months' }] },
          headerSubtext: { simpleText: 'Inner Circle' },
          ...over,
        },
      },
    },
  };
}

const giftPurchaseItem = (over: Record<string, unknown> = {}) => ({
  addChatItemAction: {
    item: {
      liveChatSponsorshipsGiftPurchaseAnnouncementRenderer: {
        id: 'gift-1',
        timestampUsec: '1700000000000000',
        authorExternalChannelId: 'UCgifter',
        header: {
          liveChatSponsorshipsHeaderRenderer: {
            authorName: { simpleText: '@generous' },
            primaryText: {
              runs: [
                { text: 'Sent ', bold: true }, { text: '5', bold: true },
                { text: ' Northlight', bold: true }, { text: ' gift memberships', bold: true },
              ],
            },
            authorBadges: [{ liveChatAuthorBadgeRenderer: {
              customThumbnail: { thumbnails: [{ url: 'mem16' }, { url: 'mem32' }] },
              tooltip: 'Member (6 months)',
            } }],
          },
        },
        ...over,
      },
    },
  },
});

const giftRedemptionItem = () => ({
  addChatItemAction: {
    item: {
      liveChatSponsorshipsGiftRedemptionAnnouncementRenderer: {
        id: 'redeem-1',
        timestampUsec: '1700000000000000',
        authorExternalChannelId: 'UClucky',
        authorName: { simpleText: '@lucky' },
        message: {
          runs: [
            { text: 'received a gift membership by ', italics: true },
            { text: '@generous', bold: true, italics: true },
          ],
        },
      },
    },
  },
});

const frame = (actions: unknown[], continuation: string | null, wrapper = 'invalidationContinuationData') => ({
  continuationContents: {
    liveChatContinuation: {
      actions,
      continuations: continuation ? [{ [wrapper]: { continuation, timeoutMs: 10000 } }] : [],
    },
  },
});

/* ------------------------------------------------------------------ harness */

interface Timer { id: number; at: number; fn: () => void }

function harness(over: Partial<SourceOptions> & {
  pages?: Record<string, string | Error>;
  polls?: Array<unknown | Error>;
} = {}) {
  const messages: ChatMessage[] = [];
  const paces: Array<number | undefined> = [];
  const removals: RemoveRequest[] = [];
  const statuses: Array<{ state: string; detail: string }> = [];
  const posted: unknown[] = [];
  const fetched: string[] = [];
  let now = 0;
  let nextId = 1;
  let timers: Timer[] = [];
  let step = 0;

  const pages = over.pages ?? {};
  const polls = over.polls ?? [frame([], 'NEXT')];

  const source = new YouTubeSource({
    channel: 'somechannel',
    onMessage: (m, paceMs) => { messages.push(m); paces.push(paceMs); },
    onRemove: (r) => removals.push(r),
    onStatus: (_s, state, detail) => statuses.push({ state, detail }),
    getConfig: () => ({ emotes: true, thirdPartyEmotes: true, exactColors: true }),
    setTimeoutFn: (fn, ms) => { const id = nextId++; timers.push({ id, at: now + ms, fn }); return id; },
    clearTimeoutFn: (h) => { timers = timers.filter((t) => t.id !== h); },
    random: () => 0.5,
    now: () => now,
    httpText: async (url) => {
      fetched.push(url);
      // Longest key first: '/live_chat' contains '/live'.
      const hit = Object.entries(pages)
        .sort((a, b) => b[0].length - a[0].length)
        .find(([key]) => url.includes(key));
      if (!hit) throw new Error('no page for ' + url);
      if (hit[1] instanceof Error) throw hit[1];
      return hit[1];
    },
    httpPost: async (url, body) => {
      posted.push({ url, body });
      const next = polls[Math.min(step++, polls.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
    ...over,
  });

  /** Run every timer due within `ms`, flushing microtasks between each. */
  const advance = async (ms: number) => {
    const target = now + ms;
    for (let guard = 0; guard < 5000; guard++) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = timers[0];
      if (!next || next.at > target) break;
      timers.shift();
      now = next.at;
      next.fn();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
    now = target;
  };
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

  return {
    source, messages, removals, statuses, posted, fetched, advance, settle, paces,
    timers: () => timers,
    text: () => messages.map((m) => m.parts.map((p) => (p.type === 'emote' ? p.name : p.value)).join('')),
    chat: () => messages.filter((m) => m.kind === 'chat'),
    system: () => messages.filter((m) => m.kind !== 'chat')
      .map((m) => m.parts.map((p) => (p.type === 'emote' ? '' : p.value)).join('')),
  };
}

/** A channel that is live, with one message waiting on the page. */
const livePages = (videoId = 'rFZHOHl-L8A', over: Record<string, unknown> = {}) => ({
  '/live': livePage(videoId),
  '/live_chat': chatPage(over),
});

/* -------------------------------------------------------------------- badges */

describe('ytBadges', () => {
  const badge = (renderer: unknown) => ytBadges([{ liveChatAuthorBadgeRenderer: renderer }]);

  it('draws membership artwork, at the largest size offered', () => {
    expect(badge({
      customThumbnail: { thumbnails: [{ url: 's16', width: 16 }, { url: 's32', width: 32 }] },
      tooltip: 'Member (6 months)',
    })).toEqual([{ kind: 'subscriber', label: 'MEM', url: 's32', title: 'Member (6 months)' }]);
  });

  /** YouTube publishes no artwork for these, only a name — so they are chips. */
  it('turns the named roles into the kinds the stylesheet already colours', () => {
    expect(badge({ icon: { iconType: 'MODERATOR' }, tooltip: 'Moderator' })[0])
      .toEqual({ kind: 'moderator', label: 'MOD', url: null, title: 'Moderator' });
    expect(badge({ icon: { iconType: 'OWNER' }, tooltip: 'Owner' })[0]?.kind).toBe('broadcaster');
    expect(badge({ icon: { iconType: 'VERIFIED' }, tooltip: 'Verified' })[0]?.kind).toBe('premium');
  });

  it('shows a role it has never heard of rather than dropping it', () => {
    expect(badge({ icon: { iconType: 'NEW_THING' } })[0])
      .toEqual({ kind: 'generic', label: 'NEW', url: null, title: 'new_thing' });
    expect(badge({ tooltip: 'mystery' })[0]?.kind).toBe('generic');
  });

  it('names a membership badge that arrived without a tooltip', () => {
    expect(badge({ customThumbnail: { thumbnails: [{ url: 's32' }] } })[0]?.title).toBe('member');
  });

  it('ignores anything that is not a badge', () => {
    expect(ytBadges(undefined)).toEqual([]);
    expect(ytBadges('no')).toEqual([]);
    expect(ytBadges([{ somethingElse: {} }, null])).toEqual([]);
    expect(badge({ customThumbnail: { thumbnails: [] } })[0]?.url).toBeNull();
    expect(badge({ customThumbnail: { thumbnails: [{}] } })[0]?.url).toBeNull();
  });

  it('stops before a wall of badges pushes the message off screen', () => {
    const many = Array.from({ length: 20 }, () => ({ liveChatAuthorBadgeRenderer: { icon: { iconType: 'MODERATOR' } } }));
    expect(ytBadges(many)).toHaveLength(8);
  });
});

/* --------------------------------------------------------------------- parts */

describe('ytParts', () => {
  const emoji = (over: Record<string, unknown>) => ({
    emoji: { image: { thumbnails: [{ url: 'w24' }, { url: 'w48' }] }, ...over },
  });

  it('renders emote artwork straight off the message — there is no catalogue', () => {
    expect(ytParts([{ text: 'hi ' }, emoji({ emojiId: '🥱', shortcuts: [':yawn:'] })], true)).toEqual([
      { type: 'text', value: 'hi ' },
      { type: 'emote', url: 'w48', name: ':yawn:' },
    ]);
  });

  it('links urls in the text like every other source', () => {
    expect(ytParts([{ text: 'see https://example.com/x now' }], true)).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'url', value: 'https://example.com/x' },
      { type: 'text', value: ' now' },
    ]);
  });

  /** With emotes off a standard emoji is its own best text; a custom one is not. */
  it('falls back to the character for a standard emoji and the shortcut for a custom one', () => {
    expect(ytParts([emoji({ emojiId: '🥱', shortcuts: [':yawn:'] })], false))
      .toEqual([{ type: 'text', value: '🥱' }]);
    expect(ytParts([emoji({ emojiId: 'UCx/abc', shortcuts: [':_hype:'], isCustomEmoji: true })], false))
      .toEqual([{ type: 'text', value: ':_hype:' }]);
  });

  it('uses whichever name an emoji actually carries when emotes are off', () => {
    // A custom emoji with no shortcut has only its id; a standard one with no
    // id has only its shortcut. Either is better than an empty message.
    expect(ytParts([emoji({ emojiId: 'UCx/abc', isCustomEmoji: true })], false))
      .toEqual([{ type: 'text', value: 'UCx/abc' }]);
    expect(ytParts([emoji({ shortcuts: [':yawn:'] })], false))
      .toEqual([{ type: 'text', value: ':yawn:' }]);
  });

  it('copes with runs that are missing the parts it wants', () => {
    expect(ytParts(undefined, true)).toEqual([]);
    expect(ytParts([{}], true)).toEqual([]);
    expect(ytParts([{ emoji: { emojiId: 'x' } }], true)).toEqual([{ type: 'text', value: 'x' }]);
    expect(ytParts([{ emoji: { shortcuts: 'no', image: { thumbnails: [{ url: 'u' }] } } }], true))
      .toEqual([{ type: 'emote', url: 'u', name: '' }]);
  });
});

/* -------------------------------------------------------------------- connect */

/* ------------------------------------------------------------- text shapes */

/**
 * The migration seen from underneath. The `…Renderer` family writes a flat
 * string as `{ simpleText }` and a styled one as `{ runs: [{ text }] }`; the
 * `…ViewModel` family writes `{ content }` and moves the styling into a
 * parallel array. Reading all three is what lets one parser cover both
 * spellings of every type below.
 */
describe('ytText and ytBody', () => {
  it('reads all three of the shapes a line of text arrives in', () => {
    expect(ytText({ simpleText: '¥5,000' })).toBe('¥5,000');
    expect(ytText({ content: '¥5,000', styleRuns: [{ startIndex: 0, length: 6 }] })).toBe('¥5,000');
    expect(ytText({ runs: [{ text: 'Member for ' }, { text: '4' }, { text: ' months' }] }))
      .toBe('Member for 4 months');
  });

  it('is empty rather than broken when the node is not there at all', () => {
    expect(ytText(null)).toBe('');
    expect(ytText({ runs: 'not an array' })).toBe('');
    expect(ytBody(null, true)).toEqual([]);
  });

  it('keeps emotes and links out of a body, whichever shape it came in', () => {
    expect(ytBody({ runs: [{ text: 'see https://example.com' }] }, true).map((p) => p.type))
      .toEqual(['text', 'url']);
    expect(ytBody({ content: 'see https://example.com' }, true).map((p) => p.type))
      .toEqual(['text', 'url']);
    expect(ytBody({ simpleText: 'plain' }, true)).toEqual([{ type: 'text', value: 'plain' }]);
  });
});

/* ---------------------------------------------------------------- the items */

describe('what a chat item turns into', () => {
  const drawn = async (...actions: unknown[]) => {
    const h = harness({ pages: livePages(), polls: [frame(actions, 'N1')] });
    await h.source.connect();
    await h.advance(1);
    return h.chat();
  };
  const said = (m: ChatMessage | undefined) =>
    (m?.parts ?? []).map((p) => (p.type === 'emote' ? `[${p.name}]` : p.value)).join('');

  it('draws a superchat as a chat message with the amount on it', async () => {
    const [msg] = await drawn(paidItem('¥5,000', 'thanks for the stream'));
    expect(msg?.kind).toBe('chat');
    expect(msg?.user).toBe('@bigspender');
    expect(msg?.userId).toBe('UCpaid');
    expect(said(msg)).toBe('thanks for the stream');
    // The amount is the platform's own formatted string, kept verbatim: this
    // app has no business reformatting a currency it does not understand.
    expect(msg?.paid?.amount).toBe('¥5,000');
    // 0xFFC2185B, the magenta tier — the alpha byte dropped and an ink chosen
    // that can be read on it.
    expect(msg?.paid?.swatch).toEqual({ bg: 'rgb(194, 24, 91)', ink: '#ffffff' });
  });

  it('draws a superchat that was sent with no message at all', async () => {
    // Which is ordinary — a great many are the amount and nothing else — and
    // was the case most likely to be dropped by a parser that assumed text.
    const [msg] = await drawn(paidItem('$2.00'));
    expect(msg?.paid?.amount).toBe('$2.00');
    expect(msg?.parts).toEqual([]);
  });

  it('keeps a superchat legible when the tier arrives with no colour', async () => {
    const [msg] = await drawn(paidItem('€1.00', 'hi', {
      headerBackgroundColor: undefined, bodyBackgroundColor: undefined,
    }));
    expect(msg?.paid).toEqual({ amount: '€1.00', swatch: null });
  });

  it('falls back to the body colour when only that one arrived', async () => {
    const [msg] = await drawn(paidItem('€1.00', 'hi', { headerBackgroundColor: undefined }));
    expect(msg?.paid?.swatch?.bg).toBe('rgb(233, 30, 99)');
  });

  it('renders the emotes and links inside a superchat like any other message', async () => {
    const [msg] = await drawn(paidItem('¥500', undefined, {
      message: { runs: [
        { text: 'see https://example.com/clip ' },
        { emoji: { emojiId: '🔥', shortcuts: [':fire:'], image: { thumbnails: [{ url: 'big.png' }] } } },
      ] },
    }));
    expect(msg?.parts.map((p) => p.type)).toEqual(['text', 'url', 'text', 'emote']);
  });

  it('says how long a member has been one, as something they did not say', async () => {
    const [msg] = await drawn(memberItem());
    // An action, so the colon becomes a space and the line reads as a sentence
    // rather than as the member announcing their own tenure out loud.
    expect(msg?.action).toBe(true);
    expect(msg?.user).toBe('@regular');
    expect(said(msg)).toBe('Member for 4 months · Inner Circle');
  });

  it('welcomes a brand-new member, who has no tenure to report yet', async () => {
    const [msg] = await drawn(memberItem({
      headerPrimaryText: undefined,
      headerSubtext: { runs: [{ text: 'Welcome to ' }, { text: 'Inner Circle' }, { text: '!' }] },
    }));
    expect(said(msg)).toBe('Welcome to Inner Circle!');
  });

  it('carries the words a member wrote on their milestone', async () => {
    const [msg] = await drawn(memberItem({ message: { runs: [{ text: 'best year yet' }] } }));
    expect(said(msg)).toBe('Member for 4 months · Inner Circle — best year yet');
  });

  it('draws gift memberships bought, with the buyer as the author', async () => {
    const [msg] = await drawn(giftPurchaseItem());
    expect(msg?.action).toBe(true);
    // The name and the badges are nested inside the header on this one; the
    // channel id a ban would name is still on the item itself.
    expect(msg?.user).toBe('@generous');
    expect(msg?.userId).toBe('UCgifter');
    expect(msg?.badges.map((b) => b.title)).toEqual(['Member (6 months)']);
    expect(said(msg)).toBe('Sent 5 Northlight gift memberships');
  });

  it('and gift memberships received', async () => {
    const [msg] = await drawn(giftRedemptionItem());
    expect(msg?.action).toBe(true);
    expect(msg?.user).toBe('@lucky');
    expect(said(msg)).toBe('received a gift membership by @generous');
  });

  it('says nothing at all for an item that arrived with nothing in it', async () => {
    // A gift purchase whose header is missing, and a text message with no text:
    // half-parsed shapes that would otherwise paint a blank line under a name.
    expect(await drawn(
      giftPurchaseItem({ header: undefined }),
      // A header that is there but holds nothing an author could be read out of.
      giftPurchaseItem({ header: { liveChatSponsorshipsHeaderRenderer: 'moved' } }),
      { addChatItemAction: { item: { liveChatTextMessageRenderer: { id: 'empty' } } } },
    )).toEqual([]);
  });

  /**
   * The migration. YouTube is renaming these types from `…Renderer` to
   * `…ViewModel`, one at a time — `giftMessageViewModel` has already gone and
   * its neighbours have not — and a live channel can hand over either spelling
   * for the same event. The lookup is keyed on the name with the spelling
   * taken off, so the day one flips it keeps being drawn.
   */
  describe('either spelling of the same event', () => {
    it('draws the gift message YouTube has already moved to a ViewModel', async () => {
      // Read off a live channel: the ViewModel family writes its text as
      // `{ content }` with the styling in a parallel array, where the renderer
      // family writes `{ simpleText }` or `{ runs }`.
      const [msg] = await drawn({
        addChatItemAction: {
          item: {
            giftMessageViewModel: {
              id: 'gm-1',
              text: { content: 'sent Tea money', styleRuns: [{ startIndex: 0, length: 14 }] },
              authorName: { content: '@stargazer', styleRuns: [{ startIndex: 0, length: 10 }] },
              giftImage: { sources: [{ url: 'tea.png', width: 480 }] },
            },
          },
        },
      });
      expect(msg?.user).toBe('@stargazer');
      expect(said(msg)).toBe('sent Tea money');
      expect(msg?.action).toBe(true);
    });

    it('draws a superchat that arrives under the ViewModel name', async () => {
      const [msg] = await drawn({
        addChatItemAction: {
          item: {
            liveChatPaidMessageViewModel: {
              id: 'sc-vm',
              timestampUsec: '1700000000000000',
              authorName: { content: '@bigspender' },
              authorExternalChannelId: 'UCpaid',
              purchaseAmountText: { content: '¥5,000' },
              headerBackgroundColor: 4290910299,
              message: { content: 'thanks' },
            },
          },
        },
      });
      expect(msg?.paid).toEqual({ amount: '¥5,000', swatch: { bg: 'rgb(194, 24, 91)', ink: '#ffffff' } });
      expect(said(msg)).toBe('thanks');
      expect(msg?.userId).toBe('UCpaid');
    });

    it('draws a membership that arrives under the ViewModel name', async () => {
      const [msg] = await drawn({
        addChatItemAction: {
          item: {
            liveChatMembershipItemViewModel: {
              id: 'mem-vm',
              timestampUsec: '1700000000000000',
              authorName: { content: '@regular' },
              authorExternalChannelId: 'UCmember',
              headerPrimaryText: { content: 'Member for 4 months' },
            },
          },
        },
      });
      expect(msg?.action).toBe(true);
      expect(said(msg)).toBe('Member for 4 months');
    });

    it('leaves a name it does not know alone, whichever way it is spelled', () => {
      expect(ytItemKind('liveChatPaidMessageRenderer')).toBe('liveChatPaidMessage');
      expect(ytItemKind('liveChatPaidMessageViewModel')).toBe('liveChatPaidMessage');
      // Neither suffix: left exactly as it came, so it matches nothing.
      expect(ytItemKind('liveChatSomethingElse')).toBe('liveChatSomethingElse');
    });
  });

  /**
   * Moderation has to reach a superchat the same way it reaches anything else.
   * A paid message is a chat message with an amount on it, not a second kind
   * of thing, so it carries the author's channel id and the feed's own rules
   * do the rest — including the ones that run before it has been painted.
   */
  it('lets a ban take a superchat down along with the rest of the author', async () => {
    const h = harness({
      pages: livePages(),
      polls: [frame([
        paidItem('¥5,000', 'thanks'),
        { removeChatItemByAuthorAction: { externalChannelId: 'UCpaid' } },
      ], 'N1')],
    });
    await h.source.connect();
    await h.advance(1);
    expect(h.chat()[0]?.userId).toBe('UCpaid');
    expect(h.removals[0]).toEqual({ platform: 'youtube', channel: 'somechannel', userId: 'UCpaid' });
  });

  it('lets a single deletion take a superchat down by its own id', async () => {
    const h = harness({
      pages: livePages(),
      polls: [frame([
        paidItem('¥5,000', 'thanks'),
        { removeChatItemAction: { targetItemId: 'sc-1' } },
      ], 'N1')],
    });
    await h.source.connect();
    await h.advance(1);
    expect(h.chat()[0]?.id).toBe('youtube:somechannel:sc-1');
    expect(h.removals[0]).toEqual({ ids: ['youtube:somechannel:sc-1'] });
  });

  it('does not replay a superchat that was already in the page backlog', async () => {
    const h = harness({
      pages: livePages('rFZHOHl-L8A', { actions: [paidItem('¥5,000', 'thanks')] }),
      polls: [frame([paidItem('¥5,000', 'thanks')], 'N1')],
    });
    await h.source.connect();
    await h.advance(1);
    expect(h.chat()).toHaveLength(1);
  });
});

describe('connecting', () => {
  it('resolves a channel to its live stream and reads the unfiltered chat', async () => {
    const h = harness({ pages: livePages(), polls: [frame([chatItem('hello')], 'N1')] });
    await h.source.connect();
    await h.advance(1);

    expect(h.fetched[0]).toBe('https://www.youtube.com/somechannel/live');
    expect(h.fetched[1]).toContain('live_chat?v=rFZHOHl-L8A');
    expect(h.source.videoId).toBe('rFZHOHl-L8A');
    expect(h.statuses.map((s) => s.state)).toContain('online');
    expect(h.system()).toContain('connected — youtube/somechannel');
    // ALL, not TOP: the page's own default hides messages.
    expect((h.posted[0] as { body: { continuation: string } }).body.continuation).toBe('ALL');
    expect((h.posted[0] as { url: string }).url).toBe(YT_CHAT_POLL_URL);
    expect(h.text()).toContain('hello');
  });

  it('renders a message with its author, badges and timestamp', async () => {
    const h = harness({
      pages: livePages(),
      polls: [frame([chatItem('hi', {
        authorBadges: [{ liveChatAuthorBadgeRenderer: { icon: { iconType: 'MODERATOR' }, tooltip: 'Moderator' } }],
      })], 'N1')],
    });
    await h.source.connect();
    await h.advance(1);
    const msg = h.chat()[0];
    expect(msg?.user).toBe('@viewer');
    // The login drops the handle's @, because that is what a ban names.
    expect(msg?.userLogin).toBe('viewer');
    expect(msg?.userId).toBe('UCabc');
    expect(msg?.color).toMatch(/^#|^hsl/);
    expect(msg?.badges[0]?.kind).toBe('moderator');
    expect(msg?.ts).toBe(1700000000000);
    expect(msg?.id).toBe('youtube:somechannel:m-hi');
  });

  it('starts the feed with the backlog the chat page already carries', async () => {
    const h = harness({
      pages: livePages('rFZHOHl-L8A', { actions: [chatItem('earlier'), chatItem('older')] }),
      polls: [frame([], 'N1')],
    });
    await h.source.connect();
    expect(h.text()).toEqual(expect.arrayContaining(['earlier', 'older']));
  });

  it('takes a pasted stream link without looking up a channel at all', async () => {
    const h = harness({
      channel: 'https://www.youtube.com/watch?v=rFZHOHl-L8A',
      pages: { '/live_chat': chatPage() },
    });
    await h.source.connect();
    expect(h.fetched).toHaveLength(1);
    expect(h.fetched[0]).toContain('live_chat?v=rFZHOHl-L8A');
  });

  it('refuses input that names nothing, and retries rather than wedging', async () => {
    const h = harness({ channel: '   ' });
    await h.source.connect();
    expect(h.statuses.at(-2)).toEqual({ state: 'error', detail: 'not a youtube channel or video' });
    expect(h.statuses.at(-1)?.state).toBe('connecting');
  });

  it('treats a page it cannot read as an error to retry, not as offline', async () => {
    const h = harness({ pages: { '/live': livePage('rFZHOHl-L8A'), '/live_chat': '<html>nope</html>' } });
    await h.source.connect();
    expect(h.statuses.at(-2)).toEqual({ state: 'error', detail: 'chat page not understood' });
    expect(h.statuses.at(-1)?.state).toBe('connecting');
  });

  it('does the same when the page has a chat but no client version', async () => {
    const html = chatPage().replace(/"INNERTUBE_CLIENT_VERSION":"[^"]*"/, '');
    const h = harness({ pages: { '/live': livePage('rFZHOHl-L8A'), '/live_chat': html } });
    await h.source.connect();
    expect(h.statuses.at(-2)?.detail).toBe('chat page not understood');
  });

  it('reports a page that will not load, and backs off', async () => {
    const h = harness({ pages: { '/live': new Error('HTTP 503') } });
    await h.source.connect();
    expect(h.statuses.at(-2)).toEqual({ state: 'error', detail: 'HTTP 503' });
  });

  it('says so plainly when no http was wired up at all', async () => {
    const h = harness({ pages: {}, httpText: undefined });
    await h.source.connect();
    expect(h.statuses.at(-2)?.detail).toBe('no http available');
  });

  it('polls nowhere, quietly, when no post was wired up either', async () => {
    const h = harness({ pages: livePages(), httpPost: undefined });
    await h.source.connect();
    await h.advance(1);
    // Connected — the pages answered — but every poll fails, which is silence
    // until the watchdog has asked and been ignored.
    expect(h.statuses.at(-1)?.state).toBe('online');
    expect(h.chat()).toHaveLength(0);
  });

  /*
   * The bug: a channel created since 2022 has only a handle, so
   * `youtube.com/PlayWithDeepx/live` is a 404 and `/@PlayWithDeepx/live` is the
   * page — measured against real YouTube. Nobody should have to know to type
   * the @. The typed form still goes first, because a bare word is also a
   * legacy custom url that resolves on its own.
   */
  it('falls back to the handle when the name as typed is not a channel', async () => {
    const h = harness({
      pages: {
        '/somechannel/live': new Error('HTTP 404'),
        '/@somechannel/live': livePage('rFZHOHl-L8A'),
        '/live_chat': chatPage(),
      },
      polls: [frame([chatItem('hello')], 'N1')],
    });
    await h.source.connect();
    await h.advance(1);

    expect(h.fetched[0]).toBe('https://www.youtube.com/somechannel/live');
    expect(h.fetched[1]).toBe('https://www.youtube.com/@somechannel/live');
    expect(h.statuses.map((st) => st.state)).toContain('online');
    expect(h.text()).toContain('hello');
  });

  /**
   * `ipcMain.handle` logs every rejection, so leaving the miss in place would
   * write an `HTTP 404` into the log of a perfectly healthy channel every two
   * minutes for as long as it is not streaming.
   */
  it('asks the form that answered first from then on, so the miss is paid once', async () => {
    const h = harness({
      pages: {
        '/somechannel/live': new Error('HTTP 404'),
        '/@somechannel/live': livePage(null),
      },
    });
    await h.source.connect();
    expect(h.fetched).toEqual([
      'https://www.youtube.com/somechannel/live',
      'https://www.youtube.com/@somechannel/live',
    ]);

    // Not live, so it comes back around on the slow cadence — and goes straight
    // to the form that worked.
    await h.advance(YT_NOT_LIVE_MS + 1);
    expect(h.fetched.slice(2)).toEqual(['https://www.youtube.com/@somechannel/live']);
  });

  /**
   * Remembering is only an ordering, never a decision. A channel that is
   * renamed, or a page that fails once, must still resolve through the form
   * that is left.
   */
  it('still tries the other form when the one it remembers stops answering', async () => {
    const pages: Record<string, string | Error> = {
      '/somechannel/live': new Error('HTTP 404'),
      '/@somechannel/live': livePage(null),
    };
    const h = harness({ pages });
    await h.source.connect();

    pages['/@somechannel/live'] = new Error('HTTP 503');
    pages['/somechannel/live'] = livePage(null);
    await h.advance(YT_NOT_LIVE_MS + 1);
    expect(h.fetched.slice(2)).toEqual([
      'https://www.youtube.com/@somechannel/live',
      'https://www.youtube.com/somechannel/live',
    ]);
    expect(h.statuses.at(-1)).toEqual({ state: 'idle', detail: 'not live' });
  });

  /** A channel that answers to the name as typed never pays for the second. */
  it('does not ask for the handle when the name as typed answers', async () => {
    const h = harness({ pages: livePages() });
    await h.source.connect();
    expect(h.fetched.filter((u) => u.includes('/@'))).toEqual([]);
  });

  it('reports the error of the form the user typed when neither is a channel', async () => {
    const h = harness({
      pages: {
        '/somechannel/live': new Error('HTTP 404'),
        '/@somechannel/live': new Error('HTTP 500'),
      },
    });
    await h.source.connect();
    expect(h.fetched).toHaveLength(2);
    expect(h.statuses.at(-2)).toEqual({ state: 'error', detail: 'HTTP 404' });
  });

  /**
   * `@name`, a channel id and a pasted url each name one thing exactly, so a
   * miss is a miss — there is no second form to try and no second request.
   */
  it('has nothing to fall back to when the name already carries its @', async () => {
    const h = harness({
      channel: '@somechannel',
      pages: { '/@somechannel/live': new Error('HTTP 404') },
    });
    await h.source.connect();
    expect(h.fetched).toEqual(['https://www.youtube.com/@somechannel/live']);
    expect(h.statuses.at(-2)).toEqual({ state: 'error', detail: 'HTTP 404' });
  });

  it('gives up on a connect whose chat page arrives after it was destroyed', async () => {
    let source: { destroy(): void } | null = null;
    const h = harness({
      httpText: async (url: string) => {
        if (!url.includes('live_chat')) return livePage('rFZHOHl-L8A');
        source?.destroy();
        return chatPage();
      },
    });
    source = h.source;
    await h.source.connect();
    expect(h.statuses.map((st) => st.state)).not.toContain('online');
    expect(h.posted).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------- not live */

describe('a channel that is not live', () => {
  it('is a state, not a failure: it says so once and keeps checking', async () => {
    const h = harness({ pages: { '/live': livePage(null) } });
    await h.source.connect();

    expect(h.statuses.at(-1)).toEqual({ state: 'idle', detail: 'not live' });
    expect(h.system()).toEqual(['not live — youtube/somechannel']);
    // On the slow cadence, not the connection backoff — this is normal, and the
    // page that answers the question is over a megabyte.
    expect(h.timers()[0]?.at).toBe(YT_NOT_LIVE_MS);

    await h.advance(YT_NOT_LIVE_MS * 3 + 1);
    expect(h.system()).toEqual(['not live — youtube/somechannel']);
    expect(h.fetched.length).toBeGreaterThan(3);
  });

  it('reads a live video whose chat is switched off the same way', async () => {
    const h = harness({ pages: { '/live': livePage('rFZHOHl-L8A'), '/live_chat': NO_CHAT } });
    await h.source.connect();
    expect(h.statuses.at(-1)).toEqual({ state: 'idle', detail: 'not live' });
  });

  it('connects by itself once the channel goes live, with nobody pressing anything', async () => {
    const pages: Record<string, string> = { '/live': livePage(null) };
    const h = harness({ pages, polls: [frame([chatItem('we are live')], 'N1')] });
    await h.source.connect();
    expect(h.statuses.at(-1)?.state).toBe('idle');

    pages['/live'] = livePage('rFZHOHl-L8A');
    pages['/live_chat'] = chatPage();
    await h.advance(YT_NOT_LIVE_MS + 1);

    expect(h.statuses.at(-1)?.state).toBe('online');
    expect(h.system()).toContain('connected — youtube/somechannel');
    expect(h.text()).toContain('we are live');
  });

  it('says it again after a stream it was watching ends', async () => {
    const pages: Record<string, string> = { '/live': livePage('rFZHOHl-L8A'), '/live_chat': chatPage() };
    const h = harness({ pages, polls: [frame([], 'N1'), frame([], null)] });
    await h.source.connect();
    await h.advance(20000);

    expect(h.system()).toContain('lost — youtube/somechannel');
    pages['/live'] = livePage(null);
    await h.advance(60000);
    expect(h.system()).toContain('not live — youtube/somechannel');
  });
});

/* --------------------------------------------------------------------- polling */

describe('polling', () => {
  it('follows the continuation the server hands back, at the interval it asks for', async () => {
    const h = harness({
      pages: livePages(),
      polls: [frame([chatItem('one')], 'N1'), frame([chatItem('two')], 'N2')],
    });
    await h.source.connect();
    await h.advance(1);
    expect(h.text()).toContain('one');

    await h.advance(10000);
    expect(h.text()).toContain('two');
    expect((h.posted[1] as { body: { continuation: string } }).body.continuation).toBe('N1');
  });

  /**
   * The other half of the pacing in ../../src/renderer/feed.ts. A poll's answer
   * is a lump of everything said since the last one, so the feed is told how
   * long it has before the next lump and lets this one out across it. A socket
   * hands nothing over, and is not paced.
   */
  it('hands on the interval the server asked for, and nothing for its own lines', async () => {
    const h = harness({
      pages: livePages(),
      polls: [frame([chatItem('one'), chatItem('two')], 'N1')],
    });
    await h.source.connect();
    await h.advance(1);
    const paced = h.messages.map((m, i) => [m.kind, h.paces[i]] as const);
    // The connection line is the app's own, not part of any batch.
    expect(paced.filter(([kind]) => kind !== 'chat').map(([, p]) => p)).toEqual([undefined]);
    // Ten seconds is what this answer's continuation asks for, so it is the
    // window the two messages it carries are spread over.
    expect(paced.filter(([kind]) => kind === 'chat').map(([, p]) => p)).toEqual([10000, 10000]);
  });

  it('carries a deleted message and a banned author back out', async () => {
    const h = harness({
      pages: livePages(),
      polls: [frame([
        chatItem('bye'),
        { removeChatItemAction: { targetItemId: 'gone' } },
        { removeChatItemByAuthorAction: { externalChannelId: 'UCabc' } },
      ], 'N1')],
    });
    await h.source.connect();
    await h.advance(1);
    expect(h.removals[0]).toEqual({ ids: ['youtube:somechannel:gone'] });
    // By channel id, which is the only thing about a YouTube author that is
    // unique: display names are freely reusable, and a troll who copies a
    // regular's name would otherwise take the regular's messages down too.
    expect(h.removals[1]).toEqual({ platform: 'youtube', channel: 'somechannel', userId: 'UCabc' });
  });

  it('names an author it never rendered by id, so nothing on screen can match it', async () => {
    const h = harness({
      pages: livePages(),
      polls: [frame([{ removeChatItemByAuthorAction: { externalChannelId: 'UCnever' } }], 'N1')],
    });
    await h.source.connect();
    await h.advance(1);
    expect(h.removals[0]).toEqual({ platform: 'youtube', channel: 'somechannel', userId: 'UCnever' });
  });

  /**
   * YouTube is mid-migration from `…Renderer` to `…ViewModel` names across
   * exactly these types. An unknown one has to mean "one message did not
   * appear", never "chat stopped".
   */
  it('walks past a renderer it has never seen without dropping the ones it knows', async () => {
    const h = harness({
      pages: livePages(),
      polls: [frame([
        { addChatItemAction: { item: { liveChatSomethingShippedThisMorningRenderer: { id: 'x' } } } },
        { addChatItemAction: { item: { somethingShippedThisMorningViewModel: { id: 'y' } } } },
        // A renderer that is not an object, an item that is not one, and an
        // action carrying no item at all.
        { addChatItemAction: { item: { liveChatTextMessageRenderer: 'not an object' } } },
        { addChatItemAction: { item: 'moved somewhere else entirely' } },
        { addChatItemAction: {} },
        { addLiveChatTickerItemAction: {} },
        { somethingIntroducedThisMorning: {} },
        chatItem('still here'),
      ], 'N1')],
    });
    await h.source.connect();
    await h.advance(1);
    // One message, and it is the one that was understood: nothing was invented
    // for the seven actions that were not, and nothing threw.
    expect(h.chat().map((m) => m.parts.map((p) => (p.type === 'emote' ? '' : p.value)).join('')))
      .toEqual(['still here']);
    expect(h.statuses.at(-1)?.state).toBe('online');
  });

  /**
   * The superchat ticker along the top of YouTube's own chat repeats every
   * paid message that already came down as a chat item. It arrives under its
   * own action, never inside `addChatItemAction`, and drawing it would put
   * every superchat in the feed twice.
   */
  it('does not draw the ticker copy of a superchat it has already drawn', async () => {
    const h = harness({
      pages: livePages(),
      polls: [frame([
        paidItem('¥5,000', 'thanks'),
        { addLiveChatTickerItemAction: { item: { liveChatTickerPaidMessageItemRenderer: {
          id: 'ticker', showItemEndpoint: { showLiveChatItemEndpoint: { renderer: {
            liveChatPaidMessageRenderer: { id: 'sc-1', purchaseAmountText: { simpleText: '¥5,000' } },
          } } },
        } } } },
      ], 'N1')],
    });
    await h.source.connect();
    await h.advance(1);
    expect(h.chat().filter((m) => m.paid)).toHaveLength(1);
  });

  it('makes a message an unreadable id could not identify anyway', async () => {
    const h = harness({
      pages: livePages(),
      polls: [frame([{ addChatItemAction: { item: { liveChatTextMessageRenderer: { message: { runs: [{ text: 'x' }] } } } } }], 'N1')],
    });
    await h.source.connect();
    await h.advance(1);
    const msg = h.chat()[0];
    expect(msg?.id).toMatch(/^youtube:somechannel:/);
    expect(msg?.ts).toBe(0);
    expect(msg?.user).toBe('');
  });

  it('starts again from the page when the token has gone stale', async () => {
    const h = harness({
      pages: livePages(),
      polls: [frame([], 'N1', 'reloadContinuationData'), frame([chatItem('back')], 'N2')],
    });
    await h.source.connect();
    await h.advance(1);
    // Re-resolved rather than kept polling a token that will never advance.
    expect(h.fetched.filter((u) => u.includes('/live_chat'))).toHaveLength(2);
    expect(h.statuses.filter((s) => s.state === 'online')).toHaveLength(2);
    // Invisible plumbing: the chat never went away, so the feed does not say
    // "connected" a second time for one continuous session.
    expect(h.system()).toEqual(['connected — youtube/somechannel']);
  });

  /**
   * The same answer twice is not a stale token, it is a chat that cannot be
   * followed — and re-resolving it on the spot re-downloads two pages, one of
   * them over a megabyte, as fast as the network will answer.
   */
  it('does not hammer the pages when the token comes back stale again and again', async () => {
    const h = harness({
      pages: livePages(),
      polls: [frame([], 'N1', 'reloadContinuationData')],
    });
    await h.source.connect();
    await h.advance(1);
    // One immediate re-resolve, then the connection backoff like any other
    // disconnect — not a page fetch per network round trip.
    expect(h.fetched.length).toBeLessThanOrEqual(4);

    await h.advance(300000);
    expect(h.fetched.length).toBeLessThan(40);
    // And it says so once, rather than filling the feed with the news.
    expect(h.system().filter((s) => s.startsWith('lost —'))).toHaveLength(1);
    expect(h.system().filter((s) => s.startsWith('connected —'))).toHaveLength(1);
  });

  it('backs off further the longer the token keeps coming back stale', async () => {
    const h = harness({ pages: livePages(), polls: [frame([], 'N1', 'reloadContinuationData')] });
    await h.source.connect();
    await h.advance(60000);
    const early = h.fetched.length;
    await h.advance(60000);
    // The second minute costs fewer page fetches than the first: the curve is
    // climbing rather than sitting at one interval.
    expect(h.fetched.length - early).toBeLessThan(early);
  });

  it('says so, and says it again, when a stale chat comes back', async () => {
    const h = harness({
      pages: livePages(),
      polls: [
        frame([], 'N1', 'reloadContinuationData'),
        frame([], 'N1', 'reloadContinuationData'),
        frame([chatItem('back')], 'N2'),
      ],
    });
    await h.source.connect();
    await h.advance(60000);
    expect(h.text()).toContain('back');
    expect(h.system()).toEqual([
      'connected — youtube/somechannel',
      'lost — youtube/somechannel',
      'connected — youtube/somechannel',
    ]);
  });

  /**
   * Every connect re-reads the chat page, which carries the last few minutes of
   * chat with it. Replaying that is a handful of messages the user has already
   * read reappearing at the bottom of the feed, minutes out of order.
   */
  it('does not replay the page backlog when it picks the chat up again', async () => {
    const h = harness({
      pages: livePages('rFZHOHl-L8A', { actions: [chatItem('earlier'), chatItem('older')] }),
      polls: [frame([], 'N1', 'reloadContinuationData'), frame([chatItem('new')], 'N2')],
    });
    await h.source.connect();
    await h.advance(1);
    expect(h.text().filter((s) => s === 'earlier')).toHaveLength(1);
    expect(h.text().filter((s) => s === 'older')).toHaveLength(1);
    expect(h.text()).toContain('new');
  });

  it('remembers only a bounded number of messages, however long it runs', async () => {
    const many = (from: number) => Array.from({ length: 300 }, (_, i) => chatItem('m' + (from + i)));
    const h = harness({
      pages: livePages(),
      polls: [frame(many(0), 'N1'), frame(many(300), 'N2'), frame(many(600), 'N3'),
        frame([chatItem('m0')], 'N4')],
    });
    await h.source.connect();
    await h.advance(60000);
    // 900 messages later the oldest ids are gone, so an id that old is new
    // again — which is the price of not growing without limit.
    expect(h.text().filter((s) => s === 'm0')).toHaveLength(2);
  });

  /**
   * A chat that was being followed and then ends is a connection going away, so
   * it goes out through the same door every disconnect uses — and quickly, since
   * a 24/7 channel rolls one stream straight into the next.
   */
  it('treats a chat it was following and lost as a connection lost', async () => {
    const h = harness({
      pages: livePages(),
      polls: [frame([chatItem('one')], 'N1'), frame([chatItem('last words')], null)],
    });
    await h.source.connect();
    await h.advance(20000);
    expect(h.text()).toContain('last words');
    expect(h.system()).toContain('lost — youtube/somechannel');
    expect(h.source.videoId).toBeNull();
  });

  it('does the same when the envelope itself disappears', async () => {
    const h = harness({ pages: livePages(), polls: [frame([], 'N1'), { nothing: true }] });
    await h.source.connect();
    await h.advance(20000);
    expect(h.system()).toContain('lost — youtube/somechannel');
  });

  /**
   * The loop this exists to prevent: YouTube's channel page goes on advertising
   * a stream whose chat has already closed, so resolving it succeeds and the
   * first poll immediately fails. On a connection backoff that is a re-download
   * of a megabyte-and-a-bit every second or two, forever, saying nothing.
   */
  it('does not loop when the page still offers a stream whose chat is over', async () => {
    const h = harness({ pages: livePages(), polls: [frame([], null)] });
    await h.source.connect();
    await h.advance(1);
    // There was no chat to lose, so this is the ordinary "not live" state.
    expect(h.system()).toEqual(['connected — youtube/somechannel', 'not live — youtube/somechannel']);
    expect(h.statuses.at(-1)).toEqual({ state: 'idle', detail: 'not live' });
    // Not a failure and not painted as one: the bar draws only exceptions, and
    // most channels are not live most of the time.

    const tries = h.fetched.length;
    await h.advance(30000);
    // Slow cadence: nothing like the once-a-second the backoff curve would give.
    expect(h.fetched.length).toBe(tries);
    await h.advance(YT_NOT_LIVE_MS);
    expect(h.fetched.length).toBeGreaterThan(tries);
  });

  it('runs one poll at a time even when the watchdog asks mid-flight', async () => {
    const h = harness({ pages: livePages() });
    await h.source.connect();
    await h.advance(1);
    const before = h.posted.length;
    // Two requests for a poll, back to back, with none of them awaited.
    void h.source.poll();
    void h.source.poll();
    await h.settle();
    expect(h.posted.length).toBe(before + 1);
  });
});

/* ------------------------------------------------------------------- liveness */

describe('the liveness watchdog', () => {
  /**
   * A poll answered is the round trip the watchdog wants, so silence here means
   * polls have stopped coming back — not that nobody is talking. The same
   * judgement the sockets make, reached by the transport rather than by a probe
   * invented for it.
   */
  it('says nothing about a chat where nobody is talking', async () => {
    const h = harness({ pages: livePages(), polls: [frame([], 'N1')] });
    await h.source.connect();
    await h.advance(YT_IDLE_MS * 4);
    expect(h.statuses.filter((s) => s.state === 'offline')).toHaveLength(0);
    expect(h.system()).toEqual(['connected — youtube/somechannel']);
  });

  it('asks before it gives up when the polls stop being answered', async () => {
    const h = harness({ pages: livePages(), polls: [frame([], 'N1'), new Error('offline')] });
    await h.source.connect();
    await h.advance(1);
    const statusesBefore = h.statuses.length;

    // Two short of the idle mark, because advance() is relative and one
    // millisecond has already gone by.
    await h.advance(YT_IDLE_MS - 2);
    expect(h.statuses.slice(statusesBefore).map((s) => s.state)).not.toContain('offline');
    const probes = h.posted.length;
    // The watchdog's own question, asked at the idle mark rather than a
    // scheduled poll that happened to be due: probe() clears whatever was
    // pending first, so this is one request and not two.
    await h.advance(2);
    expect(h.posted.length).toBe(probes + 1);

    await h.advance(PROBE_GRACE_MS);
    expect(h.statuses.at(-2)).toEqual({ state: 'offline', detail: 'no reply — reconnecting' });
    expect(h.system()).toContain('no reply — reconnecting youtube/somechannel');
  });

  it('stops polling the moment it gives up on the connection', async () => {
    const h = harness({ pages: livePages(), polls: [frame([], 'N1'), new Error('gone')] });
    await h.source.connect();
    await h.advance(YT_IDLE_MS + PROBE_GRACE_MS + 1);
    expect(h.system()).toContain('no reply — reconnecting youtube/somechannel');
    // It has just told the user this connection is dead. The polls it had
    // queued have to die with it, or they arrive after the funeral — deliver
    // messages while the bar says offline, and re-arm the watchdog on a source
    // the app has already given up on.
    expect(h.timers()).toHaveLength(1);
  });

  it('throws away a poll that was still in flight when it gave up', async () => {
    const held: Array<(value: unknown) => void> = [];
    let posts = 0;
    const h = harness({
      pages: livePages(),
      httpPost: async () => {
        posts += 1;
        return new Promise((resolve) => { held.push(resolve); });
      },
    });
    await h.source.connect();
    await h.advance(YT_IDLE_MS + PROBE_GRACE_MS + 1);
    expect(h.system()).toContain('no reply — reconnecting youtube/somechannel');

    const inFlight = posts;
    held.forEach((resolve) => resolve(frame([chatItem('from the grave')], 'N2')));
    await h.settle();
    expect(h.text()).not.toContain('from the grave');
    expect(posts).toBe(inFlight);
    expect(h.timers()).toHaveLength(1);
  });

  /**
   * A poll answered with 429 or 500 is not a blip, and answering it at the
   * cadence of a healthy chat is how a client earns a longer ban than the one
   * it already has.
   */
  it('slows down while every poll is failing, rather than keeping the pace', async () => {
    let posts = 0;
    const h = harness({
      pages: livePages(),
      httpPost: async () => { posts += 1; throw new Error('HTTP 429'); },
    });
    await h.source.connect();
    await h.advance(YT_IDLE_MS - 1);
    expect(posts).toBeLessThanOrEqual(5);
  });

  it('keeps trying quietly while a poll is merely failing', async () => {
    const h = harness({ pages: livePages(), polls: [frame([], 'N1'), new Error('blip')] });
    await h.source.connect();
    await h.advance(1);
    const tries = h.posted.length;
    await h.advance(30000);
    expect(h.posted.length).toBeGreaterThan(tries);
    expect(h.system()).toEqual(['connected — youtube/somechannel']);
  });

  it('recovers without a word when the polls come back', async () => {
    const h = harness({
      pages: livePages(),
      polls: [frame([], 'N1'), new Error('blip'), frame([chatItem('still here')], 'N2')],
    });
    await h.source.connect();
    await h.advance(YT_IDLE_MS + PROBE_GRACE_MS);
    expect(h.text()).toContain('still here');
    expect(h.system()).toEqual(['connected — youtube/somechannel']);
  });
});

/* -------------------------------------------------------------------- destroy */

describe('destroy', () => {
  it('stops the poll loop and every timer with it', async () => {
    const h = harness({ pages: livePages() });
    await h.source.connect();
    await h.advance(1);
    const before = h.posted.length;

    h.source.destroy();
    await h.advance(YT_NOT_LIVE_MS * 2);
    expect(h.posted.length).toBe(before);
    expect(h.timers()).toHaveLength(0);
  });

  it('does not wedge when a reconnect throws on its way out', async () => {
    // connect() is async here, so a throw after the try block is a rejected
    // promise nobody holds — and BaseSource's retry timer holds nothing.
    let boom = false;
    const h = harness({
      pages: livePages(),
      polls: [frame([], 'N1'), frame([], null)],
      onMessage: () => { if (boom) throw new Error('renderer blew up'); },
    });
    await h.source.connect();
    await h.advance(20000);
    expect(h.statuses.at(-1)?.state).toBe('idle');

    boom = true;
    await h.advance(YT_NOT_LIVE_MS + 1);
    expect(h.statuses.map((s) => s.detail)).toContain('renderer blew up');
    expect(h.timers().length).toBeGreaterThan(0);
  });

  it('leaves a connect already in flight with nothing to do', async () => {
    const h = harness({ pages: livePages() });
    const connecting = h.source.connect();
    h.source.destroy();
    await connecting;
    expect(h.statuses.map((s) => s.state)).not.toContain('online');
    expect(h.posted).toHaveLength(0);
  });

  it('ignores a poll that lands after it', async () => {
    const h = harness({ pages: livePages() });
    await h.source.connect();
    await h.advance(1);
    const polling = h.source.poll();
    h.source.destroy();
    await polling;
    expect(h.source.videoId).toBe('rFZHOHl-L8A');
  });

  it('schedules nothing more when a failing poll lands after it', async () => {
    let source: { destroy(): void } | null = null;
    const h = harness({
      pages: livePages(),
      httpPost: async () => { source?.destroy(); throw new Error('gone'); },
    });
    source = h.source;
    await h.source.connect();
    await h.advance(1);
    expect(h.timers()).toHaveLength(0);
  });

  it('will not reconnect, and will not go on saying it is offline', async () => {
    const h = harness({ pages: { '/live': livePage(null) } });
    h.source.destroy();
    await h.source.connect();
    expect(h.statuses).toHaveLength(0);
    expect(h.fetched).toHaveLength(0);
  });
});
