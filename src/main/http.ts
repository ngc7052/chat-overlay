import { rewriteApiUrl } from './endpoints.js';

/**
 * What the main process is willing to fetch on the renderer's behalf.
 *
 * The renderer has no network of its own — no Node integration, and a
 * Content-Security-Policy that names only the two chat sockets — so everything
 * else goes through here. That makes this list the whole outbound surface of
 * the app, which is why the check lives in one function that every handler
 * calls rather than being repeated per endpoint — and why a redirect off it is
 * refused rather than followed; see outbound().
 */
export const ALLOWED_HOSTS = new Set([
  'goodgame.ru',
  'api2.goodgame.ru',
  'static.goodgame.ru',
  '7tv.io',
  'api.betterttv.net',
  'api.frankerfacez.com',
  'api.ivr.fi',
  // YouTube live chat: the watch page, the chat page and the endpoint they
  // poll are all on this one host. Emoji and badge artwork is not fetched
  // here — the renderer loads it as <img>, under the img-src policy.
  'www.youtube.com',
]);

/**
 * How the app names itself to the small services it asks for emote catalogues.
 */
export const USER_AGENT = 'ChatOverlay/1.0';

/**
 * Hosts that serve an honest client worse than an anonymous one.
 *
 * YouTube's live chat page sniffs the user agent and answers anything it does
 * not recognise with "Oh no! It looks like you're using an older version of
 * your browser. Please update it to use live chat." — a 1.4 KB stub instead of
 * the page, with a 200 on it. Sending nothing lets Electron's own user agent
 * out instead, which is not a disguise: this is Chromium, of a version newer
 * than most of the browsers YouTube does accept.
 */
const SNIFFS_USER_AGENT = new Set(['www.youtube.com']);

/**
 * The headers a request goes out with, decided from the url the app asked for
 * rather than the one it ends up fetching — so the e2e override cannot quietly
 * change them.
 */
export function requestHeaders(url: string, extra: Record<string, string>): Record<string, string> {
  const headers = { ...extra };
  // Safe to parse: allowedUrl has already refused anything that is not a url.
  if (!SNIFFS_USER_AGENT.has(new URL(url).hostname)) headers['User-Agent'] = USER_AGENT;
  return headers;
}

/**
 * Google's cookie-consent state, as a browser that has answered the banner
 * carries it.
 *
 * Without it, every youtube.com request from inside the EU is answered 200 with
 * a 34 KB "before you continue" interstitial instead of the page — so the chat
 * source sees no video on the channel and reports it as not live, forever, for
 * European users only. It is invisible from anywhere else, which is exactly why
 * it is written down here: a CI box in the US never meets it.
 *
 * It has to go in the session's cookie jar rather than on the request. Chromium
 * treats `Cookie` as a forbidden header and drops it from a fetch() silently,
 * with no error and no warning — the request simply goes out without it.
 */
export const CONSENT_COOKIE = { name: 'SOCS', value: 'CAI' };

/**
 * Where to install it. Production is youtube.com; the end-to-end harness points
 * every allowed request at a loopback server instead, and that server refuses to
 * serve a chat page without the cookie exactly as Google does — so the fix stays
 * proven by a test rather than by having been seen to work once.
 */
export function consentCookies(testBase?: string | null): Array<{ url: string; name: string; value: string }> {
  const urls = ['https://www.youtube.com', ...(testBase ? [testBase] : [])];
  return urls.map((url) => ({ url, ...CONSENT_COOKIE }));
}

/**
 * How long a request may go on before it is abandoned.
 *
 * Nothing else bounds one. A response that opens and then trickles nothing — a
 * captive portal, a proxy, a half-open NAT — leaves the promise pending for
 * ever, and a source that awaited it sits in `connecting` with no watchdog, no
 * retry and no poll armed: wedged until the user toggles the row. Chromium will
 * usually error such a socket eventually, but "usually" is not a guarantee, and
 * this is the only place one can be written down.
 *
 * Comfortably longer than any of these endpoints takes, including YouTube's
 * megabyte-and-a-bit pages on a slow line, and comfortably shorter than the
 * liveness watchdog that is waiting on the answer.
 */
export const REQUEST_TIMEOUT_MS = 30000;

/** A request the main process is prepared to make, url and options together. */
export interface Outbound {
  url: string;
  init: {
    method?: string;
    headers: Record<string, string>;
    body?: string;
    redirect: 'error';
    signal: AbortSignal;
  };
}

/**
 * Everything about one outbound request, decided in one place.
 *
 * The allowlist is only the whole outbound surface if it is checked against the
 * url that is actually fetched, and `net.fetch` follows redirects by default: a
 * 30x from an allowed host would carry the request — and this session's cookie
 * jar with it — to a host nobody allowed, and hand the body back to the
 * renderer as if it had come from the allowed one. None of the eight hosts
 * redirects any path this app asks for, measured against all of them, so a
 * redirect is not something to follow carefully. It is something that has
 * changed, and it fails here rather than quietly off the list.
 */
export function outbound(
  url: string,
  accept: Record<string, string>,
  testBase?: string | null,
  post?: { body: unknown },
): Outbound {
  const target = allowedUrl(url, testBase);
  return {
    url: target,
    init: {
      ...(post ? { method: 'POST', body: JSON.stringify(post.body ?? {}) } : {}),
      headers: requestHeaders(url, accept),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  };
}

/**
 * The url to actually request, or a throw.
 *
 * The allowlist is checked against the **real** host first and the test
 * override applied afterwards, so the override can only ever redirect a
 * request the app was already allowed to make.
 */
export function allowedUrl(url: string, testBase?: string | null): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('bad url');
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error('host not allowed: ' + parsed.hostname);
  }
  return rewriteApiUrl(url, testBase);
}
