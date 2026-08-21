import type { MessagePart } from '../util.js';
import type { PlatformName } from '../../main/types.js';

export type MessageKind = 'chat' | 'system' | 'event';

export interface Badge {
  kind: string;
  label: string;
  url: string | null;
  title: string;
}

export interface ChatMessage {
  id: string;
  platform: PlatformName;
  channel: string;
  userId?: string;
  user: string;
  userLogin: string;
  color: string;
  badges: Badge[];
  parts: MessagePart[];
  kind: MessageKind;
  action?: boolean;
  ts: number;
}

export interface RemoveRequest {
  ids?: string[];
  platform?: PlatformName;
  channel?: string;
  user?: string;
  /**
   * The platform's own id for the author, where it has one that is unique.
   * YouTube's display names are not, so a ban that named one would remove the
   * messages of anyone else using the same name.
   */
  userId?: string;
  all?: boolean;
}

/**
 * `idle` is the state that is neither working nor broken: connected to a
 * channel that simply has nothing to carry — a YouTube channel that is not
 * streaming, which is where most channels are most of the time. It is kept
 * apart from `offline` because the bar draws only what is wrong, and this is
 * not wrong.
 */
export type ConnectionState = 'connecting' | 'online' | 'offline' | 'error' | 'idle';

/** The bits of a WebSocket the sources actually use, so tests can supply a fake. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface HttpJson {
  (url: string): Promise<unknown>;
}

/**
 * The two shapes YouTube needs that a JSON GET cannot cover: its continuation
 * token is scraped out of an HTML page, and its chat endpoint is a POST.
 * Both go through the main process against the same host allowlist.
 */
export interface HttpText {
  (url: string): Promise<string>;
}

export interface HttpPost {
  (url: string, body: unknown): Promise<unknown>;
}

export interface EmoteEntry { url: string; fallback?: string }
export interface BadgeEntry { url: string; title: string }

/** Emote/badge catalogues, injected so sources can be tested without network. */
export interface AssetApi {
  goodgameSmiles(channelId: string): Promise<Map<string, EmoteEntry>>;
  twitchThirdParty(roomId: string): Promise<Map<string, EmoteEntry>>;
  twitchBadges(roomId: string): Promise<Map<string, BadgeEntry>>;
}

export interface SourceOptions {
  channel: string;
  /** Overrides the chat endpoint; only the e2e harness sets it. */
  wsUrl?: string | null;
  /** Overrides where GoodGame's icon SVGs are fetched from; e2e only. */
  iconBase?: string | null;
  channelIconBase?: string | null;
  /** Overrides where Twitch's own emote artwork is fetched from; e2e only. */
  emoteBase?: string | null;
  /**
   * `paceMs` is how long this source expects to wait before its next arrival.
   * A socket hands messages over as they are said and passes nothing; a poller
   * arrives in lumps and names the interval between them, which is what lets
   * the feed let a lump out across it rather than all at once.
   */
  onMessage(msg: ChatMessage, paceMs?: number): void;
  onRemove?(req: RemoveRequest): void;
  onStatus?(source: { key: string; platform: PlatformName; channel: string }, state: ConnectionState, detail: string): void;
  getConfig(): { emotes: boolean; thirdPartyEmotes: boolean; exactColors: boolean };
  createSocket?: SocketFactory;
  httpJson?: HttpJson;
  /** YouTube only; see HttpText / HttpPost. */
  httpText?: HttpText;
  httpPost?: HttpPost;
  assets?: AssetApi;
  /** Reported when a catalogue fails to load; the chat itself carries on. */
  onWarn?(message: string): void;
  /**
   * Collapses both liveness-watchdog waits — how long a silent socket is left
   * alone, and how long its probe is given to be answered — to this one value.
   * Only the end-to-end harness sets it, so a stall scenario finishes in
   * seconds instead of minutes.
   */
  watchdogMs?: number | null;
  /** Injected so retry timing is deterministic in tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  random?: () => number;
  now?: () => number;
}
