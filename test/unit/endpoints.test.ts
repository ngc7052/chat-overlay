import { describe, expect, it } from 'vitest';
import { resolveEndpoints, rewriteApiUrl } from '../../src/main/endpoints.js';

/**
 * These exist so end-to-end runs can point the app at a local fake server.
 * A real install sets none of them, so the "unset" case is the one that must
 * never change behaviour.
 */

describe('resolveEndpoints', () => {
  it('is null for a normal install', () => {
    expect(resolveEndpoints({}))
      .toEqual({
        twitchWs: null, goodgameWs: null,
        ggIconBase: null, ggChannelIconBase: null, twitchEmoteBase: null,
        watchdogMs: null,
      });
  });

  it('passes the overrides through when the harness sets them', () => {
    expect(resolveEndpoints({
      OVERLAY_TWITCH_WS: 'ws://127.0.0.1:1/irc',
      OVERLAY_GOODGAME_WS: 'ws://127.0.0.1:1/chat2/',
      OVERLAY_GG_ICON_BASE: 'http://127.0.0.1:1/gg-icons/',
      OVERLAY_GG_CHANNEL_ICON_BASE: 'http://127.0.0.1:1/files/icons/',
      OVERLAY_TWITCH_EMOTE_BASE: 'http://127.0.0.1:1/emoticons/v2/',
      OVERLAY_TEST_WATCHDOG_MS: '2500',
    })).toEqual({
      twitchWs: 'ws://127.0.0.1:1/irc',
      goodgameWs: 'ws://127.0.0.1:1/chat2/',
      ggIconBase: 'http://127.0.0.1:1/gg-icons/',
      ggChannelIconBase: 'http://127.0.0.1:1/files/icons/',
      twitchEmoteBase: 'http://127.0.0.1:1/emoticons/v2/',
      watchdogMs: 2500,
    });
  });

  it('treats one override as independent of the other', () => {
    expect(resolveEndpoints({ OVERLAY_TWITCH_WS: 'ws://x/1' })).toEqual({
      twitchWs: 'ws://x/1', goodgameWs: null,
      ggIconBase: null, ggChannelIconBase: null, twitchEmoteBase: null,
      watchdogMs: null,
    });
  });

  it('leaves the watchdog alone when the override is empty or nonsense', () => {
    // A real install has none of these set at all; an empty string is what a
    // harness that only fills the variable in for one scenario leaves behind.
    expect(resolveEndpoints({ OVERLAY_TEST_WATCHDOG_MS: '' }).watchdogMs).toBeNull();
    expect(resolveEndpoints({ OVERLAY_TEST_WATCHDOG_MS: 'soon' }).watchdogMs).toBeNull();
    expect(resolveEndpoints({ OVERLAY_TEST_WATCHDOG_MS: '0' }).watchdogMs).toBeNull();
  });
});

describe('rewriteApiUrl', () => {
  it('leaves the url alone when no override is configured', () => {
    const url = 'https://goodgame.ru/api/4/smiles';
    expect(rewriteApiUrl(url, null)).toBe(url);
    expect(rewriteApiUrl(url, undefined)).toBe(url);
    expect(rewriteApiUrl(url, '')).toBe(url);
  });

  it('swaps host and scheme but keeps the route, so fixtures match production', () => {
    expect(rewriteApiUrl('https://api.ivr.fi/v2/twitch/badges/channel?id=42', 'http://127.0.0.1:8731'))
      .toBe('http://127.0.0.1:8731/v2/twitch/badges/channel?id=42');
  });

  it('keeps the path of every provider it is pointed at', () => {
    for (const [url, expected] of [
      ['https://goodgame.ru/api/getchannelstatus?fmt=json&id=x', 'http://127.0.0.1:9/api/getchannelstatus?fmt=json&id=x'],
      ['https://7tv.io/v3/emote-sets/global', 'http://127.0.0.1:9/v3/emote-sets/global'],
      ['https://api.betterttv.net/3/cached/emotes/global', 'http://127.0.0.1:9/3/cached/emotes/global'],
    ] as const) {
      expect(rewriteApiUrl(url, 'http://127.0.0.1:9')).toBe(expected);
    }
  });
});
