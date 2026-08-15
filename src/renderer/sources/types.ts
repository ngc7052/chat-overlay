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
  all?: boolean;
}

export type ConnectionState = 'connecting' | 'online' | 'offline' | 'error';

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
  onMessage(msg: ChatMessage): void;
  onRemove?(req: RemoveRequest): void;
  onStatus?(source: { key: string; platform: PlatformName; channel: string }, state: ConnectionState, detail: string): void;
  getConfig(): { emotes: boolean; thirdPartyEmotes: boolean; exactColors: boolean };
  createSocket?: SocketFactory;
  httpJson?: HttpJson;
  assets?: AssetApi;
  /** Reported when a catalogue fails to load; the chat itself carries on. */
  onWarn?(message: string): void;
  /** Injected so retry timing is deterministic in tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  random?: () => number;
  now?: () => number;
}
