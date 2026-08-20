import type { PlatformName } from '../../main/types.js';
import type {
  ChatMessage, ConnectionState, RemoveRequest, SocketFactory, SocketLike, SourceOptions,
} from './types.js';

/** WebSocket.OPEN. A socket in CLOSING is still non-null, and send() throws. */
const OPEN = 1;

/**
 * How long a probe is given to be answered before the socket is called dead.
 *
 * Shared by both platforms because it asks about the network, not about either
 * protocol: GoodGame answers its ping in well under a second and Twitch replies
 * to PING immediately, so this is a couple of orders of magnitude of headroom.
 * Erring long is deliberate — reconnecting a socket that was fine would drop
 * chat for every user, which is worse than the silence this is here to catch.
 */
export const PROBE_GRACE_MS = 15000;

/**
 * Shared connection handling: retry with backoff, status reporting, the system
 * lines the feed shows when a channel connects or drops, and the liveness
 * watchdog that notices a connection nobody has closed.
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
  protected watchdog: unknown = null;
  private probing = false;
  /** Whether this source has ever been connected, so a drop can be told from
      a channel that has never come up in the first place. */
  private wasOnline = false;
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
  protected readonly wsUrl: string | null;
  /** Collapses both watchdog waits to one value; the e2e harness only. */
  protected readonly watchdogMs: number | null;

  /** How long this platform's socket may be silent before it is worth asking. */
  protected abstract readonly idleMs: number;

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
    this.wsUrl = opts.wsUrl ?? null;
    this.watchdogMs = opts.watchdogMs ?? null;
  }

  get key(): string {
    return this.platform + ':' + this.channel.toLowerCase();
  }

  protected status(state: ConnectionState, detail = ''): void {
    if (state === 'online') this.wasOnline = true;
    this.onStatus({ key: this.key, platform: this.platform, channel: this.channel }, state, detail);
  }

  /**
   * The socket went away by itself — the server closed it, or the network did.
   *
   * This writes the line the feed was missing. A connection coming back has
   * always said so; one going away said nothing at all, so a reader of the
   * feed saw "connected — twitch/x", then silence, and could not tell a dead
   * socket from a channel where nobody was talking. That is the whole question
   * the liveness work exists to answer, and while the overlay is locked the
   * feed is the only surface left to answer it on.
   *
   * Only for a connection that was working: a channel that has never come up
   * retries on a backoff curve, and announcing each attempt would bury the
   * chat under a connection log.
   */
  protected socketGone(): void {
    this.status('offline');
    if (this.wasOnline) this.system(`lost — ${this.platform}/${this.channel}`);
    this.wasOnline = false;
    this.scheduleRetry();
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

  /**
   * Send, but only at a socket that can take it.
   *
   * `this.ws` being non-null is not enough: a socket in CLOSING is still there
   * and send() throws on it, which inside a timer callback is an unhandled
   * error rather than a dropped frame.
   */
  protected send(data: string): void {
    if (this.ws && this.ws.readyState === OPEN) this.ws.send(data);
  }

  /**
   * A frame arrived, so the connection demonstrably still works — whatever the
   * frame happened to say.
   *
   * Counting *anything* inbound is deliberately weaker than tracking a specific
   * reply, and that is the point: an error frame, a viewer count or somebody
   * saying hello all prove the same thing, so the watchdog cannot be fooled by
   * a protocol detail changing underneath it.
   */
  protected noteAlive(): void {
    this.probing = false;
    this.armWatchdog(this.watchdogMs ?? this.idleMs);
  }

  private armWatchdog(ms: number): void {
    this.clearTimeoutFn(this.watchdog);
    this.watchdog = this.setTimeoutFn(() => this.watchdogFired(), ms);
  }

  protected clearWatchdog(): void {
    this.clearTimeoutFn(this.watchdog);
    this.watchdog = null;
    this.probing = false;
  }

  /**
   * Nothing has arrived for `idleMs`.
   *
   * That is not proof of death — a quiet channel is the normal state of most
   * channels — so ask a question the server is known to answer, and only give
   * up when the answer never comes. Without that second step this would drop a
   * healthy connection every time a stream went quiet.
   */
  private watchdogFired(): void {
    if (this.dead) return;
    if (!this.probing) {
      this.probing = true;
      this.probe();
      this.armWatchdog(this.watchdogMs ?? PROBE_GRACE_MS);
      return;
    }
    // Open, but with nothing on the other end of it: a half-open connection
    // after a sleep, a Wi-Fi handover or a NAT timeout, where no close frame is
    // ever sent and onclose therefore never fires. Out through the same door
    // every other disconnect uses.
    this.status('offline', 'no reply — reconnecting');
    this.system(`no reply — reconnecting ${this.platform}/${this.channel}`);
    this.closeSocket();
    this.scheduleRetry();
  }

  /** Something the server is known to answer, sent when the socket goes quiet. */
  protected abstract probe(): void;

  /** Exponential backoff, capped, with jitter so many channels do not sync up. */
  protected scheduleRetry(): void {
    if (this.dead) return;
    this.clearWatchdog();
    // `attempt` is zeroed the moment a socket opens, so a watchdog firing after
    // hours of a healthy session starts this curve from the bottom, not from
    // the 30s cap a long outage would have climbed to.
    this.attempt += 1;
    const wait = Math.min(30000, 1000 * Math.pow(1.7, Math.min(this.attempt, 8)));
    const jitter = Math.round(wait * 0.25 * this.random());
    const total = wait + jitter;
    this.status('connecting', `retry in ${Math.round(total / 1000)}s`);
    this.clearTimeoutFn(this.retryTimer);
    this.retryTimer = this.setTimeoutFn(() => this.reconnect(), total);
  }

  /**
   * Run connect() from a timer, where nobody is awaiting it.
   *
   * A timer callback holds nothing: a synchronous throw is an uncaught error
   * inside it, and — since connect() may be async, YouTube's is — a rejected
   * promise is an unhandled rejection that no user, log or test ever sees.
   * Either way the source is left with no timer armed at all, wedged until the
   * row is toggled off and on. A connect that failed is a connect that failed,
   * so it goes out through the same door as one that failed politely.
   */
  protected reconnect(): void {
    try {
      const started = this.connect();
      if (started) started.catch((err: unknown) => this.connectFailed(err));
    } catch (err) {
      this.connectFailed(err);
    }
  }

  private connectFailed(err: unknown): void {
    this.status('error', (err as Error).message);
    this.scheduleRetry();
  }

  protected closeSocket(): void {
    this.clearWatchdog();
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
