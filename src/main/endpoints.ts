/**
 * Endpoint overrides, used only by the end-to-end harness.
 *
 * Tests that depend on whether someone happens to be streaming are not tests.
 * With these set, the app talks to a local fake server that speaks both chat
 * protocols and serves fixed emote/badge fixtures, so a run is reproducible and
 * needs no network. Unset — which is every real install — nothing changes.
 */

export interface Endpoints {
  twitchWs: string | null;
  goodgameWs: string | null;
  ggIconBase: string | null;
  ggChannelIconBase: string | null;
}

export interface EndpointEnv {
  OVERLAY_TWITCH_WS?: string | undefined;
  OVERLAY_GOODGAME_WS?: string | undefined;
  OVERLAY_TEST_API_BASE?: string | undefined;
  OVERLAY_GG_ICON_BASE?: string | undefined;
  OVERLAY_GG_CHANNEL_ICON_BASE?: string | undefined;
}

export function resolveEndpoints(env: EndpointEnv): Endpoints {
  return {
    twitchWs: env.OVERLAY_TWITCH_WS ?? null,
    goodgameWs: env.OVERLAY_GOODGAME_WS ?? null,
    ggIconBase: env.OVERLAY_GG_ICON_BASE ?? null,
    ggChannelIconBase: env.OVERLAY_GG_CHANNEL_ICON_BASE ?? null,
  };
}

/**
 * Point an allowed API url at the fake server, keeping path and query so the
 * fixtures are chosen by the same routes production uses.
 * Returns the url unchanged when no override is configured.
 */
export function rewriteApiUrl(url: string, base: string | null | undefined): string {
  if (!base) return url;
  const target = new URL(url);
  const root = new URL(base);
  target.protocol = root.protocol;
  target.host = root.host;
  return target.toString();
}
