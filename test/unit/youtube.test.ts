import { describe, expect, it } from 'vitest';
import { PROBE_GRACE_MS } from '../../src/renderer/sources/base.js';
import { YT_CHAT_POLL_URL } from '../../src/renderer/sources/innertube.js';
import {
  YouTubeSource, YT_IDLE_MS, YT_NOT_LIVE_MS, ytBadges, ytParts,
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
    onMessage: (m) => messages.push(m),
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
    source, messages, removals, statuses, posted, fetched, advance, settle,
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
        { addChatItemAction: { item: { giftMessageViewModel: { anything: true } } } },
        { addLiveChatTickerItemAction: {} },
        { somethingIntroducedThisMorning: {} },
        chatItem('still here'),
      ], 'N1')],
    });
    await h.source.connect();
    await h.advance(1);
    expect(h.text()).toContain('still here');
    expect(h.statuses.at(-1)?.state).toBe('online');
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
