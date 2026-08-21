import { describe, expect, it } from 'vitest';
import {
  chatPageActions, chatPageUrl, chatStart, chatTarget, clientVersion, jsonAfter, livePageUrl,
  parsePoll, pollBody, videoIdFromLivePage, YT_POLL_MAX_MS, YT_POLL_MIN_MS, YT_POLL_MS,
} from '../../src/renderer/sources/innertube.js';

/**
 * The scraping rules, against fixtures shaped like the pages they came from.
 *
 * The real pages are a megabyte each and change weekly, so what is pinned here
 * is the *shape* each rule depends on — and, for the traps, the specific way
 * the obvious implementation gets it wrong.
 */

/** The chat page assigns it one way; the watch page assigns it the other. */
const chatPage = (data: unknown, version = '2.20260817.01.00') =>
  `<script>window["ytInitialData"] = ${JSON.stringify(data)};` +
  `"INNERTUBE_API_KEY":"AIza_x","INNERTUBE_CLIENT_VERSION":"${version}"</script>`;

const watchPage = (data: unknown) =>
  `<script>var ytInitialData = ${JSON.stringify(data)};</script>`;

const liveChat = (over: Record<string, unknown> = {}) => ({
  contents: {
    liveChatRenderer: {
      continuations: [{ invalidationContinuationData: { continuation: 'TOP', timeoutMs: 10000 } }],
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
});

/** YouTube's own "no chat here" pane, whose text arrives translated. */
const noChat = { contents: { messageRenderer: { text: { runs: [{ text: 'Šai tiešraides straumei ir atspējota tērzēšana.' }] } } } };

describe('jsonAfter', () => {
  it('reads both assignment forms, because the two pages differ', () => {
    expect(jsonAfter('window["ytInitialData"] = {"a":1};', 'ytInitialData')).toEqual({ a: 1 });
    expect(jsonAfter('var ytInitialData = {"a":2};</script>', 'ytInitialData')).toEqual({ a: 2 });
  });

  it('is not fooled by a brace or a quote inside a string value', () => {
    // A lazy regex up to the first `};` stops here and loses the rest.
    const html = 'ytInitialData = {"t":"a}; b","u":"say \\"hi\\" {","v":3};';
    expect(jsonAfter(html, 'ytInitialData')).toEqual({ t: 'a}; b', u: 'say "hi" {', v: 3 });
  });

  it('handles nesting', () => {
    expect(jsonAfter('x = {"a":{"b":{"c":1}}};', 'x')).toEqual({ a: { b: { c: 1 } } });
  });

  /**
   * The marker is a string like `ytInitialData`, and a page a megabyte long
   * mentions it more than once — a guard, a comment, an inlined third-party
   * script. Taking the first occurrence and giving up when it does not parse
   * turns the channel into a permanent, silent "not live": the exact invisible
   * failure the two known YouTube gates already taught this file about.
   */
  it('walks past a mention of the marker that is not the data', () => {
    expect(jsonAfter('if (window.ytInitialData) {}; var ytInitialData = {"a":1};', 'ytInitialData'))
      .toEqual({ a: 1 });
    expect(jsonAfter('ytInitialData = {oops}; ytInitialData = {"a":2};', 'ytInitialData'))
      .toEqual({ a: 2 });
  });

  it('gives up quietly on anything it cannot read', () => {
    expect(jsonAfter('nothing here', 'ytInitialData')).toBeNull();
    expect(jsonAfter('ytInitialData = no brace', 'ytInitialData')).toBeNull();
    expect(jsonAfter('ytInitialData = {"a":1', 'ytInitialData')).toBeNull();
    expect(jsonAfter('ytInitialData = {oops};', 'ytInitialData')).toBeNull();
  });
});

describe('chatTarget', () => {
  const channel = (value: string) => ({ kind: 'channel', value });
  /** A bare word: the literal path first, `@word` to fall back on. */
  const bare = (value: string) => ({ kind: 'channel', value, alt: '@' + value });
  const video = (value: string) => ({ kind: 'video', value });

  it('takes a bare name, a handle and a channel id', () => {
    expect(chatTarget('lofigirl')).toEqual(bare('lofigirl'));
    expect(chatTarget('  @LofiGirl  ')).toEqual(channel('@LofiGirl'));
    expect(chatTarget('UCSJ4gkVC6NrvII8umztf0Ow')).toEqual(channel('channel/UCSJ4gkVC6NrvII8umztf0Ow'));
  });

  /**
   * The user's half of the bug this was written for: `PlayWithDeepx` answers
   * 404 without its `@` and 200 with it, and typing the `@` is not something
   * anyone should have to know to do. The other half is that a bare word is
   * *also* a legacy custom url — `youtube.com/PewDiePie` still resolves — so
   * the typed form is asked for first and the handle only when it misses.
   * Nothing that works today can change which channel it means.
   */
  it('offers the handle as a fallback for a bare word, never the other way round', () => {
    expect(chatTarget('PlayWithDeepx')).toEqual(bare('PlayWithDeepx'));
    expect(chatTarget('PewDiePie')).toEqual(bare('PewDiePie'));
    expect(chatTarget('youtube.com/PlayWithDeepx')).toEqual(bare('PlayWithDeepx'));
    expect(chatTarget('https://www.youtube.com/PlayWithDeepx/live')).toEqual(bare('PlayWithDeepx'));
    expect(chatTarget('some.old-name_1')).toEqual(bare('some.old-name_1'));
    // Everything that is not a bare word already names one thing exactly, so
    // there is nothing to fall back to and no second request to pay for.
    expect(chatTarget('@PlayWithDeepx')?.alt).toBeUndefined();
    expect(chatTarget('UCSJ4gkVC6NrvII8umztf0Ow')?.alt).toBeUndefined();
    expect(chatTarget('youtube.com/c/LofiGirl')?.alt).toBeUndefined();
    expect(chatTarget('youtube.com/user/Old')?.alt).toBeUndefined();
    expect(chatTarget('youtube.com/watch?v=rFZHOHl-L8A')?.alt).toBeUndefined();
  });

  it('takes the urls people actually copy', () => {
    expect(chatTarget('https://www.youtube.com/@LofiGirl')).toEqual(channel('@LofiGirl'));
    expect(chatTarget('https://www.youtube.com/@LofiGirl/live')).toEqual(channel('@LofiGirl'));
    expect(chatTarget('http://m.youtube.com/@LofiGirl/streams')).toEqual(channel('@LofiGirl'));
    expect(chatTarget('youtube.com/c/LofiGirl/')).toEqual(channel('c/LofiGirl'));
    expect(chatTarget('youtube.com/user/Old')).toEqual(channel('user/Old'));
    expect(chatTarget('www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow/videos'))
      .toEqual(channel('channel/UCSJ4gkVC6NrvII8umztf0Ow'));
  });

  it('pins one stream when a stream is what was given', () => {
    expect(chatTarget('https://www.youtube.com/watch?v=rFZHOHl-L8A')).toEqual(video('rFZHOHl-L8A'));
    expect(chatTarget('https://www.youtube.com/watch?v=rFZHOHl-L8A&t=90')).toEqual(video('rFZHOHl-L8A'));
    expect(chatTarget('https://youtu.be/rFZHOHl-L8A?si=x')).toEqual(video('rFZHOHl-L8A'));
    expect(chatTarget('youtube.com/live/rFZHOHl-L8A')).toEqual(video('rFZHOHl-L8A'));
    expect(chatTarget('youtube.com/embed/rFZHOHl-L8A')).toEqual(video('rFZHOHl-L8A'));
  });

  /**
   * A video id and a custom url are both eleven characters of the same
   * alphabet. Guessing "video" for a bare word would silently show a stranger's
   * chat to anyone whose channel name happens to be that length.
   */
  it('never guesses that a bare word is a video id', () => {
    expect(chatTarget('elevenchars')).toEqual(bare('elevenchars'));
    expect(chatTarget('rFZHOHl-L8A')).toEqual(bare('rFZHOHl-L8A'));
  });

  it('refuses what it cannot make sense of', () => {
    expect(chatTarget('')).toBeNull();
    expect(chatTarget('   ')).toBeNull();
    expect(chatTarget('https://www.youtube.com/')).toBeNull();
    expect(chatTarget('https://www.youtube.com')).toBeNull();
    expect(chatTarget('a/b/c/d')).toBeNull();
    expect(chatTarget('has spaces')).toBeNull();
    expect(chatTarget('youtube.com/live')).toBeNull();
    expect(chatTarget(undefined as unknown as string)).toBeNull();
  });
});

describe('urls', () => {
  it('asks a channel what it has live, and a video for its chat pane', () => {
    expect(livePageUrl('@LofiGirl')).toBe('https://www.youtube.com/@LofiGirl/live');
    expect(chatPageUrl('a b')).toBe('https://www.youtube.com/live_chat?v=a%20b&is_popout=1');
  });
});

describe('videoIdFromLivePage', () => {
  it('reads the video the page is playing', () => {
    expect(videoIdFromLivePage(watchPage({
      currentVideoEndpoint: { watchEndpoint: { videoId: 'rFZHOHl-L8A' } },
    }))).toBe('rFZHOHl-L8A');
  });

  /**
   * The first `"videoId"` in the document belongs to a recommendation shelf.
   * Asked twice for one channel it gave two different ids, one of them another
   * channel's stream — so the shelf must lose to the endpoint even when the
   * shelf comes first.
   */
  it('ignores the recommendation shelf, whatever order it appears in', () => {
    const html = watchPage({
      shelf: [{ videoRenderer: { videoId: 'SOMEONEELSE' } }],
      currentVideoEndpoint: { watchEndpoint: { videoId: 'rFZHOHl-L8A' } },
    });
    expect(html.indexOf('SOMEONEELSE')).toBeLessThan(html.indexOf('rFZHOHl-L8A'));
    expect(videoIdFromLivePage(html)).toBe('rFZHOHl-L8A');
  });

  it('says nothing when the channel is not live', () => {
    expect(videoIdFromLivePage(watchPage({ contents: {} }))).toBeNull();
    expect(videoIdFromLivePage(watchPage({ currentVideoEndpoint: {} }))).toBeNull();
    expect(videoIdFromLivePage(watchPage({ currentVideoEndpoint: { watchEndpoint: { videoId: 'too-short' } } }))).toBeNull();
    expect(videoIdFromLivePage('not a page at all')).toBeNull();
  });
});

describe('clientVersion', () => {
  it('is read off the page rather than hardcoded', () => {
    expect(clientVersion(chatPage(liveChat(), '2.20991231.00.00'))).toBe('2.20991231.00.00');
    expect(clientVersion('<html></html>')).toBeNull();
  });
});

describe('chatStart', () => {
  /**
   * The page opens on "Top chat", whose own subtitle says some messages may not
   * be visible. An overlay that quietly drops messages looks exactly like one
   * that works, so the unfiltered mode is the one taken.
   */
  it('takes the unfiltered "Live chat" token, not the filtered default', () => {
    expect(chatStart(chatPage(liveChat()))).toEqual({ kind: 'live', continuation: 'ALL' });
  });

  it('falls back to the page continuation when there is no view selector', () => {
    const data = liveChat();
    delete (data.contents.liveChatRenderer as { header?: unknown }).header;
    expect(chatStart(chatPage(data))).toEqual({ kind: 'live', continuation: 'TOP' });
  });

  it('falls back when the selector is there but carries no token', () => {
    const data = liveChat();
    const menu = data.contents.liveChatRenderer.header.liveChatHeaderRenderer
      .viewSelector.sortFilterSubMenuRenderer;
    menu.subMenuItems = [{ title: 'Top chat', selected: true, continuation: { reloadContinuationData: { continuation: 'TOP' } } }] as never;
    expect(chatStart(chatPage(data))).toEqual({ kind: 'live', continuation: 'TOP' });
  });

  /** Recognised by shape: the text inside it arrives in the server's language. */
  it('reads the "no chat" pane as offline, not as a failure', () => {
    expect(chatStart(chatPage(noChat))).toEqual({ kind: 'offline' });
  });

  it('falls back when the selector offers a second mode with no token on it', () => {
    const data = liveChat();
    const menu = data.contents.liveChatRenderer.header.liveChatHeaderRenderer
      .viewSelector.sortFilterSubMenuRenderer;
    menu.subMenuItems = [{ title: 'Top chat' }, { title: 'Live chat' }] as never;
    expect(chatStart(chatPage(data))).toEqual({ kind: 'live', continuation: 'TOP' });
  });

  it('reads past entries in the continuations array that carry nothing', () => {
    const data = liveChat();
    delete (data.contents.liveChatRenderer as { header?: unknown }).header;
    data.contents.liveChatRenderer.continuations = [
      null, 'nope', { empty: {} }, { a: {}, b: { continuation: 'LATER' } },
    ] as never;
    expect(chatStart(chatPage(data))).toEqual({ kind: 'live', continuation: 'LATER' });
  });

  it('calls anything else unreadable, so it is retried rather than given up on', () => {
    expect(chatStart('<html>nope</html>')).toEqual({ kind: 'unreadable' });
    expect(chatStart(chatPage({ contents: {} }))).toEqual({ kind: 'unreadable' });
    // No continuations key at all, rather than an empty one.
    const gone = liveChat();
    delete (gone.contents.liveChatRenderer as { header?: unknown }).header;
    delete (gone.contents.liveChatRenderer as { continuations?: unknown }).continuations;
    expect(chatStart(chatPage(gone))).toEqual({ kind: 'unreadable' });

    const empty = liveChat();
    empty.contents.liveChatRenderer.continuations = [] as never;
    const menu = empty.contents.liveChatRenderer.header.liveChatHeaderRenderer
      .viewSelector.sortFilterSubMenuRenderer;
    menu.subMenuItems = [] as never;
    expect(chatStart(chatPage(empty))).toEqual({ kind: 'unreadable' });
  });
});

describe('chatPageActions', () => {
  it('picks up the backlog the page already carries, so the feed is not empty', () => {
    expect(chatPageActions(chatPage(liveChat({ actions: [{ a: 1 }, { b: 2 }] })))).toHaveLength(2);
  });

  it('is empty rather than absent when there is none', () => {
    expect(chatPageActions(chatPage(liveChat()))).toEqual([]);
    expect(chatPageActions('nothing')).toEqual([]);
  });
});

describe('pollBody', () => {
  it('claims to be the web client, which is the only thing the endpoint checks', () => {
    expect(pollBody('2.1', 'TOK')).toEqual({
      context: { client: { clientName: 'WEB', clientVersion: '2.1' } },
      continuation: 'TOK',
    });
  });
});

describe('parsePoll', () => {
  const frame = (wrapper: unknown, actions: unknown[] = []) => ({
    continuationContents: {
      liveChatContinuation: { actions, continuations: wrapper ? [wrapper] : [] },
    },
  });

  it('reads actions and the next token', () => {
    const poll = parsePoll(frame({ invalidationContinuationData: { continuation: 'N', timeoutMs: 10000 } }, [{ x: 1 }]));
    expect(poll).toEqual({ actions: [{ x: 1 }], continuation: 'N', timeoutMs: 10000, stale: false });
  });

  /**
   * The wrapper key varies by stream and by moment; all three of these have
   * been seen in this position, so the token is taken by shape, not by name.
   */
  it('does not care which wrapper the token arrives in', () => {
    for (const key of ['invalidationContinuationData', 'timedContinuationData']) {
      expect(parsePoll(frame({ [key]: { continuation: 'N' } }))?.continuation).toBe('N');
    }
  });

  /** A spent token: the chat is fine, our place in it is not. */
  it('flags a reload wrapper as stale', () => {
    expect(parsePoll(frame({ reloadContinuationData: { continuation: 'N' } }))?.stale).toBe(true);
  });

  it('clamps the interval the server asks for, so it cannot become a busy loop', () => {
    expect(parsePoll(frame({ a: { continuation: 'N', timeoutMs: 1 } }))?.timeoutMs).toBe(YT_POLL_MIN_MS);
    expect(parsePoll(frame({ a: { continuation: 'N', timeoutMs: 9e9 } }))?.timeoutMs).toBe(YT_POLL_MAX_MS);
    expect(parsePoll(frame({ a: { continuation: 'N' } }))?.timeoutMs).toBe(YT_POLL_MS);
    expect(parsePoll(frame({ a: { continuation: 'N', timeoutMs: 'soon' } }))?.timeoutMs).toBe(YT_POLL_MS);
    expect(parsePoll(frame({ a: { continuation: 'N', timeoutMs: -5 } }))?.timeoutMs).toBe(YT_POLL_MS);
  });

  it('skips a hole in the continuations array', () => {
    const poll = parsePoll({
      continuationContents: {
        liveChatContinuation: { continuations: [null, 'nope', { a: { continuation: 'N' } }] },
      },
    });
    expect(poll?.continuation).toBe('N');
  });

  it('reports no token rather than throwing when the chat has run out', () => {
    expect(parsePoll(frame(null))).toEqual({ actions: [], continuation: null, timeoutMs: YT_POLL_MS, stale: false });
    expect(parsePoll(frame({ a: {} }))?.continuation).toBeNull();
    // A wrapper object with nothing in it at all.
    expect(parsePoll(frame({}))).toEqual({ actions: [], continuation: null, timeoutMs: YT_POLL_MS, stale: false });
    expect(parsePoll(frame(0 as unknown))?.continuation).toBeNull();
  });

  it('tolerates actions that are not a list', () => {
    const poll = parsePoll({ continuationContents: { liveChatContinuation: { actions: 'no' } } });
    expect(poll?.actions).toEqual([]);
  });

  /** The envelope itself gone means the stream is over, which is not an error. */
  it('is null when there is no chat envelope at all', () => {
    expect(parsePoll({})).toBeNull();
    expect(parsePoll(null)).toBeNull();
    expect(parsePoll({ continuationContents: {} })).toBeNull();
    expect(parsePoll({ error: { code: 400 } })).toBeNull();
  });
});
