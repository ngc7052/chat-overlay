/**
 * Reading YouTube's own live-chat endpoint — the one the watch page uses.
 *
 * YouTube publishes no chat socket and no anonymous chat API. What it does have
 * is `youtubei/v1/live_chat/get_live_chat`, which the browser itself polls, and
 * which answers an unauthenticated request: no account and no API key. The one
 * cookie that goes with it is Google's consent flag, which is a "yes, I saw the
 * banner" and not a credential — see CONSENT_COOKIE in main/http.ts.
 * That is the same posture as `justinfan` on Twitch, and it is why this file
 * exists rather than a YouTube Data API client — the official API needs a key
 * the user has to create in a Google Cloud console, and its default quota is
 * exhausted by a single channel left open for a day.
 *
 * The price is that the entry point is scraped out of two HTML pages, so
 * everything here is written to fail *soft*: an unrecognised shape means "not
 * live", never a thrown error, and an unrecognised message means one message
 * missing, never a chat that stops.
 *
 * Kept free of the source class so every rule below can be tested against a
 * fixture string.
 */

import { clamp } from '../../shared/clamp.js';

export const YT_ORIGIN = 'https://www.youtube.com';

/** The endpoint the browser polls. No key and no account — see the file comment. */
export const YT_CHAT_POLL_URL = YT_ORIGIN + '/youtubei/v1/live_chat/get_live_chat?prettyPrint=false';

/**
 * The client the request claims to be.
 *
 * `clientName` must be exactly this and `clientVersion` must be a plausible web
 * version — measured against the live endpoint, a version three years stale is
 * still accepted, `"1.0"` and `"garbage"` are answered 404, and omitting either
 * is answered 400. Nothing is hardcoded here anyway: the real version is read
 * off the chat page, which has to be fetched for the continuation regardless.
 */
export const YT_CLIENT_NAME = 'WEB';

/** Fallback when a response carries no interval of its own. */
export const YT_POLL_MS = 5000;
/** A server-supplied interval is clamped: 0 would be a busy loop. */
export const YT_POLL_MIN_MS = 1000;
export const YT_POLL_MAX_MS = 30000;

const VIDEO_ID = /^[\w-]{11}$/;

/**
 * Single-segment paths on youtube.com that are the site's own, not a channel's
 * custom url. Without this, `youtube.com/watch` with no `v=` reads as a channel
 * named "watch" and is then reported as permanently not live.
 */
const RESERVED = new Set([
  'live', 'watch', 'shorts', 'embed', 'feed', 'results', 'playlist', 'account',
  'gaming', 'premium', 'about', 'hashtag', 'channel', 'c', 'user',
]);

export interface Target {
  /** 'video' — a specific stream. 'channel' — whatever that channel has live. */
  kind: 'video' | 'channel';
  value: string;
  /**
   * A second channel path to ask for when `value` turns out not to name a
   * channel at all. Only a bare word has one — see chatTarget.
   */
  alt?: string;
}

/**
 * What the user typed, turned into something to look up.
 *
 * A bare word is always a channel, never a video id, even when it happens to be
 * eleven characters long — a channel whose custom url is eleven characters is
 * indistinguishable from a video id otherwise, and guessing wrong silently
 * shows a stranger's chat. A specific stream is named the way people actually
 * share one: by pasting its url.
 */
export function chatTarget(input: string): Target | null {
  let text = String(input ?? '').trim();
  if (!text) return null;

  // Strip a protocol and a known YouTube host, so a pasted url and a typed
  // name meet in the same place.
  text = text.replace(/^[a-z]+:\/\//i, '');
  const shortLink = /^youtu\.be\/([\w-]{11})/.exec(text);
  if (shortLink) return { kind: 'video', value: shortLink[1] as string };
  text = text.replace(/^(?:www\.|m\.|music\.)?youtube\.com(?:\/|$)/i, '');
  text = text.replace(/^\/+/, '');
  if (!text) return null;

  const [pathPart = '', queryPart = ''] = text.split('?', 2);
  const path = pathPart.replace(/\/+$/, '');

  // watch?v=<id>, and the /live/<id> and /shorts/<id> permalink forms.
  const query = new URLSearchParams(queryPart);
  const v = query.get('v');
  if (v && VIDEO_ID.test(v)) return { kind: 'video', value: v };
  const permalink = /^(?:live|shorts|embed|v)\/([\w-]{11})/.exec(path);
  if (permalink) return { kind: 'video', value: permalink[1] as string };

  // Everything else names a channel. `/live` is appended by livePageUrl, so a
  // url the user copied off a live page resolves to the same place as the bare
  // channel — which is what they meant either way.
  const channel = path.replace(/\/(?:live|streams|videos|featured|about)$/, '');
  if (!channel || RESERVED.has(channel.toLowerCase())) return null;
  if (/^@[\w.-]+$/.test(channel)) return { kind: 'channel', value: channel };
  if (/^UC[\w-]{22}$/.test(channel)) return { kind: 'channel', value: 'channel/' + channel };
  if (/^(?:channel|c|user)\/[\w.-]+$/.test(channel)) return { kind: 'channel', value: channel };
  // A bare word is two things at once and nothing tells them apart from here.
  // It can be a legacy custom url — `youtube.com/PewDiePie`, which predates
  // handles, is still what that channel answers to, and is what a long-standing
  // config row holds — or it can be a handle typed without its `@`, which is
  // how anyone reads a channel name aloud and is the only form a channel
  // created since 2022 has. Measured on 2026-08-21: `youtube.com/PewDiePie`,
  // `/LinusTechTips`, `/lofigirl`, `/kurzgesagt` and `/marquesbrownlee` all
  // answer 200, `/PlayWithDeepx` answers 404 while `/@PlayWithDeepx` answers
  // 200, and `/@marquesbrownlee` answers 404 while the bare one does not. So
  // both forms are live, neither covers the other, and the answer costs a
  // request.
  //
  // The literal form goes first and `@word` is the fallback, so no row that
  // resolves today can change which channel it means. Where both exist they
  // agree — checked by externalId on all five above — but "where both exist"
  // is not something this can know, and picking the handle first would silently
  // move a working row to whoever holds the matching handle.
  if (/^[\w.-]+$/.test(channel)) return { kind: 'channel', value: channel, alt: '@' + channel };
  return null;
}

/**
 * Where to ask what a channel has live right now.
 *
 * `/live` on a channel serves the watch page of its live stream. When the
 * channel is not live it still answers 200, with a page that has no video on
 * it at all — which is why liveness is decided by what came back, not by the
 * status code.
 */
export function livePageUrl(channelPath: string): string {
  return `${YT_ORIGIN}/${channelPath}/live`;
}

/** The chat pane on its own, which is where the continuation token lives. */
export function chatPageUrl(videoId: string): string {
  return `${YT_ORIGIN}/live_chat?v=${encodeURIComponent(videoId)}&is_popout=1`;
}

/**
 * The JSON object that follows `marker`, read by balancing braces.
 *
 * Not a regular expression on purpose. The two pages this reads assign
 * `ytInitialData` two different ways — `window["ytInitialData"] = {…}` on the
 * chat page and `var ytInitialData = {…}` on the watch page — and a lazy match
 * up to the first `};` stops early the moment any string value contains one.
 * Finding the marker and then counting braces handles both forms and cannot be
 * fooled by the contents.
 */
export function jsonAfter(text: string, marker: string): unknown {
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + marker.length)) {
    const found = objectAt(text, text.indexOf('{', at)) as Record<string, unknown> | null;
    // Keep looking past anything that is not it. The first mention of the
    // marker on a megabyte-long page is not necessarily the data — a guard, a
    // comment, an inlined third-party script — and taking it turns the channel
    // into a permanent, silent "not live", the same invisible failure as the
    // two YouTube gates. An empty object is no more the data than a broken one.
    if (found && Object.keys(found).length > 0) return found;
  }
  return null;
}

/** The object starting at `start`, or null if there is none that parses. */
function objectAt(text: string, start: number): unknown {
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Narrowing helper: `obj.a.b.c` over unknown, without a cast at every step. */
function dig(value: unknown, ...path: string[]): unknown {
  let at = value;
  for (const key of path) {
    if (!at || typeof at !== 'object') return null;
    at = (at as Record<string, unknown>)[key];
  }
  return at ?? null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function ytInitialData(html: string): unknown {
  return jsonAfter(html, 'ytInitialData');
}

/**
 * Which video a channel's `/live` page is actually playing.
 *
 * Read from `currentVideoEndpoint` rather than the first `"videoId"` in the
 * document, which is a recommendation shelf: asked twice in a row for one
 * channel it gave two different ids, one of them another channel's stream.
 */
export function videoIdFromLivePage(html: string): string | null {
  const id = dig(ytInitialData(html), 'currentVideoEndpoint', 'watchEndpoint', 'videoId');
  return typeof id === 'string' && VIDEO_ID.test(id) ? id : null;
}

/** The web client version the page was served with; required by every poll. */
export function clientVersion(html: string): string | null {
  return /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html)?.[1] ?? null;
}

export type ChatStart =
  | { kind: 'live'; continuation: string }
  /** The page loaded and says there is no live chat on this video. */
  | { kind: 'offline' }
  /** Neither shape recognised — treat as an error and retry, not as offline. */
  | { kind: 'unreadable' };

/**
 * The first continuation token, taken from a chat page.
 *
 * Deliberately the *unfiltered* one. The mode the page opens in is "Top chat",
 * whose own subtitle reads "Some messages, such as potential spam, may not be
 * visible" — an overlay that silently drops messages looks exactly like one
 * that works, which is the worst failure available here. The second entry is
 * "Live chat", "All messages are visible". Chosen by position because both
 * titles arrive translated into whatever language the request was served.
 */
function unfilteredContinuation(chat: unknown): string | null {
  const items = dig(chat, 'header', 'liveChatHeaderRenderer', 'viewSelector',
    'sortFilterSubMenuRenderer', 'subMenuItems');
  if (Array.isArray(items) && items.length > 1) {
    const all = text(dig(items[1], 'continuation', 'reloadContinuationData', 'continuation'));
    if (all) return all;
  }
  return firstContinuation(dig(chat, 'continuations'));
}

/**
 * The token out of a `continuations` array.
 *
 * The wrapper key varies by stream and by moment — `invalidationContinuationData`,
 * `timedContinuationData` and `reloadContinuationData` have all been observed in
 * the same position — so the value is taken by shape rather than by name.
 */
function firstContinuation(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    for (const inner of Object.values(entry as Record<string, unknown>)) {
      const token = text(dig(inner, 'continuation'));
      if (token) return token;
    }
  }
  return null;
}

export function chatStart(html: string): ChatStart {
  const data = ytInitialData(html);
  const chat = dig(data, 'contents', 'liveChatRenderer');
  if (!chat) {
    // YouTube's own "chat is disabled / not live" pane. Recognised by its
    // shape: the text inside it arrives translated.
    return dig(data, 'contents', 'messageRenderer') ? { kind: 'offline' } : { kind: 'unreadable' };
  }
  const continuation = unfilteredContinuation(chat);
  return continuation ? { kind: 'live', continuation } : { kind: 'unreadable' };
}

/** Actions embedded in the chat page itself, so the feed starts with history. */
export function chatPageActions(html: string): unknown[] {
  const actions = dig(ytInitialData(html), 'contents', 'liveChatRenderer', 'actions');
  return Array.isArray(actions) ? actions : [];
}

export function pollBody(clientVersionValue: string, continuation: string): unknown {
  return {
    context: { client: { clientName: YT_CLIENT_NAME, clientVersion: clientVersionValue } },
    continuation,
  };
}

export interface Poll {
  actions: unknown[];
  continuation: string | null;
  /** What the server asks to be waited before the next poll. */
  timeoutMs: number;
  /**
   * The token has expired and the server handed back a reload wrapper rather
   * than a rolling one. Nothing is wrong with the stream — start again from
   * the chat page instead of polling a token that will never advance.
   */
  stale: boolean;
}

/**
 * A poll response. `null` means the chat is over: the envelope is gone, so
 * there is nothing left to poll and the stream has ended.
 */
export function parsePoll(raw: unknown): Poll | null {
  const chat = dig(raw, 'continuationContents', 'liveChatContinuation');
  if (!chat) return null;

  const actions = dig(chat, 'actions');
  const list = Array.isArray(dig(chat, 'continuations')) ? dig(chat, 'continuations') as unknown[] : [];
  const wrapper = list.find((e) => e && typeof e === 'object') as Record<string, unknown> | undefined;
  const [kind = '', inner] = wrapper ? (Object.entries(wrapper)[0] ?? []) : [];
  const timeout = Number(dig(inner, 'timeoutMs'));

  return {
    actions: Array.isArray(actions) ? actions : [],
    continuation: text(dig(inner, 'continuation')),
    timeoutMs: Number.isFinite(timeout) && timeout > 0
      ? clamp(timeout, YT_POLL_MIN_MS, YT_POLL_MAX_MS)
      : YT_POLL_MS,
    stale: kind === 'reloadContinuationData',
  };
}
