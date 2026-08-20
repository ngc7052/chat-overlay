import { describe, expect, it } from 'vitest';
import {
  ALLOWED_HOSTS, allowedUrl, consentCookies, outbound, REQUEST_TIMEOUT_MS, requestHeaders,
  USER_AGENT,
} from '../../src/main/http.js';

/**
 * The app's whole outbound surface. The renderer has no network of its own, so
 * anything not permitted here cannot be reached at all — which is why the check
 * is one function rather than a copy per handler.
 */

describe('ALLOWED_HOSTS', () => {
  /**
   * Written out rather than iterated. A loop over the set under test asserts
   * only that its own members are members: delete a host and the loop simply
   * stops testing it, so the one list that decides what the app can reach
   * would have no test at all. This list is the expectation; changing it is a
   * decision, and a decision belongs in a diff.
   */
  it('is exactly the hosts the three sources need', () => {
    expect([...ALLOWED_HOSTS].sort()).toEqual([
      '7tv.io',
      'api.betterttv.net',
      'api.frankerfacez.com',
      'api.ivr.fi',
      'api2.goodgame.ru',
      'goodgame.ru',
      'static.goodgame.ru',
      'www.youtube.com',
    ]);
  });
});

describe('allowedUrl', () => {
  it('passes the hosts the sources actually need', () => {
    for (const host of ALLOWED_HOSTS) {
      expect(allowedUrl(`https://${host}/x`)).toBe(`https://${host}/x`);
    }
  });

  it('reaches youtube for chat, and nothing else of google', () => {
    expect(allowedUrl('https://www.youtube.com/live_chat?v=x'))
      .toBe('https://www.youtube.com/live_chat?v=x');
    expect(() => allowedUrl('https://youtube.com/live_chat')).toThrow(/host not allowed/);
    expect(() => allowedUrl('https://googleapis.com/youtube/v3/videos')).toThrow(/host not allowed/);
    expect(() => allowedUrl('https://evil.www.youtube.com/x')).toThrow(/host not allowed/);
    expect(() => allowedUrl('https://www.youtube.com.evil.test/x')).toThrow(/host not allowed/);
  });

  it('refuses anything that is not https', () => {
    expect(() => allowedUrl('http://goodgame.ru/x')).toThrow(/host not allowed/);
    expect(() => allowedUrl('file:///etc/passwd')).toThrow(/host not allowed/);
    expect(() => allowedUrl('javascript:alert(1)')).toThrow(/host not allowed/);
  });

  it('refuses what is not a url at all', () => {
    expect(() => allowedUrl('not a url')).toThrow('bad url');
    expect(() => allowedUrl('')).toThrow('bad url');
  });

  /**
   * The allowlist is checked against the real host and the override applied
   * afterwards, so a test base can only ever redirect a request the app was
   * already permitted to make — never open a new one.
   */
  it('applies the test override only to a request that was already allowed', () => {
    expect(allowedUrl('https://goodgame.ru/api/4/smiles', 'http://127.0.0.1:8080'))
      .toBe('http://127.0.0.1:8080/api/4/smiles');
    expect(allowedUrl('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?prettyPrint=false', 'http://127.0.0.1:8080'))
      .toBe('http://127.0.0.1:8080/youtubei/v1/live_chat/get_live_chat?prettyPrint=false');
    expect(() => allowedUrl('https://elsewhere.test/x', 'http://127.0.0.1:8080')).toThrow(/host not allowed/);
  });

  it('leaves the url alone when no override is set', () => {
    expect(allowedUrl('https://7tv.io/v3/emote-sets/global', null))
      .toBe('https://7tv.io/v3/emote-sets/global');
    expect(allowedUrl('https://7tv.io/v3/emote-sets/global', ''))
      .toBe('https://7tv.io/v3/emote-sets/global');
  });
});

describe('requestHeaders', () => {
  it('names the app to the small services it asks for catalogues', () => {
    expect(requestHeaders('https://7tv.io/v3/emote-sets/global', { Accept: 'application/json' }))
      .toEqual({ Accept: 'application/json', 'User-Agent': USER_AGENT });
  });

  /**
   * YouTube's live chat sniffs the user agent and answers one it does not know
   * with a 1.4 KB "update your browser" stub — carrying a 200, so nothing
   * upstream sees an error. Sending nothing lets Electron's own Chrome user
   * agent out, which is what this really is.
   */
  it('says nothing to youtube, which serves an honest client worse', () => {
    expect(requestHeaders('https://www.youtube.com/live_chat?v=x', { Accept: 'text/html' }))
      .toEqual({ Accept: 'text/html' });
    expect(requestHeaders('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat', {}))
      .toEqual({});
  });

  it('decides from the url the app asked for, not the one the e2e redirects to', () => {
    // allowedUrl rewrites the host for the harness; the headers must not follow.
    expect(requestHeaders('https://www.youtube.com/live_chat', {})['User-Agent']).toBeUndefined();
    expect(requestHeaders('https://goodgame.ru/api/4/smiles', {})['User-Agent']).toBe(USER_AGENT);
  });

  it('leaves the caller\'s own headers alone', () => {
    const extra = { Accept: 'application/json', 'Content-Type': 'application/json' };
    expect(requestHeaders('https://api.ivr.fi/v2/twitch/badges/global', extra))
      .toMatchObject(extra);
    expect(extra['User-Agent' as keyof typeof extra]).toBeUndefined();
  });
});

describe('consentCookies', () => {
  /**
   * Google answers a request without it with a consent interstitial — 200, and
   * the wrong page — from inside the EU only. Chromium drops a `Cookie` header
   * from a fetch silently, so it has to live in the session's jar.
   */
  it('answers the consent banner for youtube', () => {
    expect(consentCookies()).toEqual([
      { url: 'https://www.youtube.com', name: 'SOCS', value: 'CAI' },
    ]);
    expect(consentCookies(null)).toHaveLength(1);
  });

  it('also answers it for the harness, which reproduces the interstitial', () => {
    expect(consentCookies('http://127.0.0.1:8080')).toEqual([
      { url: 'https://www.youtube.com', name: 'SOCS', value: 'CAI' },
      { url: 'http://127.0.0.1:8080', name: 'SOCS', value: 'CAI' },
    ]);
  });
});

/**
 * The allowlist is only the whole outbound surface if it is checked on the url
 * that is actually fetched. `net.fetch` follows redirects by default, and a
 * 30x from an allowed host would carry the request — and the session's cookie
 * jar with it — to a host nobody allowed, with the body handed back to the
 * renderer as if it had come from the allowed one.
 *
 * None of the eight hosts redirects any of the paths this app asks for
 * (measured against all of them). So a redirect is not something to follow
 * carefully; it is something that has changed, and it fails loudly here rather
 * than quietly off the list.
 */
describe('outbound', () => {
  const init = (url: string) => outbound(url, { Accept: 'text/html' }).init;

  it('refuses to follow a redirect off the allowlist', () => {
    expect(init('https://www.youtube.com/live_chat').redirect).toBe('error');
    expect(outbound('https://7tv.io/v3/x', {}, null, { body: { a: 1 } }).init.redirect).toBe('error');
  });

  /**
   * A response that opens and then trickles nothing — a captive portal, a
   * half-open NAT — leaves the promise pending for ever, and the source that
   * awaited it sits in `connecting` with no watchdog and no timer of its own.
   */
  it('gives up on a request that never finishes', () => {
    const signal = init('https://www.youtube.com/live_chat').signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('checks the host before it builds anything at all', () => {
    expect(() => outbound('https://elsewhere.test/x', {})).toThrow(/host not allowed/);
    expect(() => outbound('not a url', {})).toThrow('bad url');
  });

  it('carries the headers and the test override the app already decided on', () => {
    const req = outbound('https://goodgame.ru/api/4/smiles', { Accept: 'application/json' }, 'http://127.0.0.1:8080');
    expect(req.url).toBe('http://127.0.0.1:8080/api/4/smiles');
    expect(req.init.headers).toEqual({ Accept: 'application/json', 'User-Agent': USER_AGENT });
    expect(req.init.method).toBeUndefined();
    expect(req.init.body).toBeUndefined();
  });

  it('serialises a post body, and sends an empty object rather than nothing', () => {
    expect(outbound('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat', {}, null,
      { body: { continuation: 'ALL' } }).init)
      .toMatchObject({ method: 'POST', body: '{"continuation":"ALL"}' });
    expect(outbound('https://www.youtube.com/x', {}, null, { body: undefined }).init.body).toBe('{}');
  });
});
