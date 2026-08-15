import type { PlatformName } from '../../main/types.js';
import type {
  ChatMessage, ConnectionState, RemoveRequest, SocketFactory, SocketLike, SourceOptions,
} from './types.js';

/**
 * Shared connection handling: retry with backoff, status reporting, and the
 * system lines the feed shows when a channel connects or drops.
 *
 * Timers, sockets and randomness are all injected so the reconnect behaviour can
 * be tested without waiting on real time or a real network.
 */
export abstract class BaseSource {
  abstract readonly platform: PlatformName;

  channel: string;
  protected ws: SocketLike | null = null;
  protected dead = false;
  protected attempt = 0;
  protected retryTimer: unknown = null;
  emoteMap = new Map<string, { url: string; fallback?: string }>();
  badgeMap = new Map<string, { url: string; title: string }>();

  protected readonly onMessage: (msg: ChatMessage) => void;
  protected readonly onRemove: (req: RemoveRequest) => void;
  protected readonly onStatus: NonNullable<SourceOptions['onStatus']>;
  protected readonly getConfig: SourceOptions['getConfig'];
  protected readonly createSocket: SocketFactory;
  protected readonly httpJson: NonNullable<SourceOptions['httpJson']>;
  protected readonly setTimeoutFn: NonNullable<SourceOptions['setTimeoutFn']>;
  protected readonly clearTimeoutFn: NonNullable<SourceOptions['clearTimeoutFn']>;
  protected readonly random: () => number;
  protected readonly now: () => number;
  protected readonly assets: SourceOptions['assets'];
  protected readonly onWarn: (message: string) => void;

  constructor(opts: SourceOptions) {
    this.channel = opts.channel;
    this.onMessage = opts.onMessage;
    this.onRemove = opts.onRemove ?? (() => {});
    this.onStatus = opts.onStatus ?? (() => {});
    this.getConfig = opts.getConfig;
    /* c8 ignore next -- the real WebSocket path; unit tests always inject a fake */
    this.createSocket = opts.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    this.httpJson = opts.httpJson ?? (async () => { throw new Error('no http available'); });
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.assets = opts.assets;
    this.onWarn = opts.onWarn ?? (() => {});
  }

  get key(): string {
    return this.platform + ':' + this.channel.toLowerCase();
  }

  protected status(state: ConnectionState, detail = ''): void {
    this.onStatus({ key: this.key, platform: this.platform, channel: this.channel }, state, detail);
  }

  protected system(text: string, kind: 'system' | 'event' = 'system'): void {
    this.onMessage({
      id: `${this.key}:sys:${this.now()}:${this.random().toString(36).slice(2, 7)}`,
      platform: this.platform,
      channel: this.channel,
      user: '',
      userLogin: '',
      color: '#b9c6dc',
      badges: [],
      parts: [{ type: 'text', value: text }],
      kind,
      ts: this.now(),
    });
  }

  /** Exponential backoff, capped, with jitter so many channels do not sync up. */
  protected scheduleRetry(): void {
    if (this.dead) return;
    this.attempt += 1;
    const wait = Math.min(30000, 1000 * Math.pow(1.7, Math.min(this.attempt, 8)));
    const jitter = Math.round(wait * 0.25 * this.random());
    const total = wait + jitter;
    this.status('connecting', `retry in ${Math.round(total / 1000)}s`);
    this.clearTimeoutFn(this.retryTimer);
    this.retryTimer = this.setTimeoutFn(() => this.connect(), total);
  }

  protected closeSocket(): void {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch { /* already gone */ }
  }

  abstract connect(): void | Promise<void>;

  destroy(): void {
    this.dead = true;
    this.clearTimeoutFn(this.retryTimer);
    this.closeSocket();
  }
}
