import { rewriteApiUrl } from './endpoints.js';

/**
 * What the main process is willing to fetch on the renderer's behalf.
 *
 * The renderer has no network of its own — no Node integration, and a
 * Content-Security-Policy that names only the two chat sockets — so everything
 * else goes through here. That makes this list the whole outbound surface of
 * the app, which is why the check lives in one function that every handler
 * calls rather than being repeated per endpoint.
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
