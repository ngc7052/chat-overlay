import type { Config, SourceConfig } from '../main/types.js';
import type { Badge, ChatMessage, ConnectionState } from './sources/types.js';

/**
 * The decisions behind what the overlay shows, kept apart from the DOM calls
 * that carry them out. Everything here is a pure function of config and state,
 * which is what makes the filtering and formatting rules testable.
 */

/** Message text with emotes removed — what the command/ignore filters look at. */
export function plainText(msg: ChatMessage): string {
  return msg.parts.map((p) => (p.type === 'emote' ? '' : p.value)).join('').trim();
}

export function shouldDrop(msg: ChatMessage, config: Config): boolean {
  // The "no channels" hint carries no channel and must always show.
  if (msg.kind !== 'chat') return !config.showSystem && !!msg.channel;

  const text = plainText(msg);
  if (config.hideCommands && text.startsWith('!')) return true;
  if (config.ignoreList.length) {
    const login = String(msg.userLogin || '').toLowerCase();
    if (config.ignoreList.some((n) => n && n.toLowerCase() === login)) return true;
  }
  return false;
}

/** Whether a message renders the platform as artwork, text, or not at all. */
export function platformMarker(msg: ChatMessage, config: Config): 'icon' | 'text' | 'none' {
  if (config.platformStyle === 'off' || !msg.channel) return 'none';
  return config.platformStyle === 'icon' ? 'icon' : 'text';
}

const PLATFORM_ICONS: Record<string, string> = {
  twitch: '../assets/twitch.svg',
  youtube: '../assets/youtube.svg',
  goodgame: '../assets/goodgame.png',
};

export function platformIconPath(platform: string): string {
  return PLATFORM_ICONS[platform] ?? PLATFORM_ICONS['goodgame'] as string;
}

/** The two letters that stand in for a platform where a name will not fit. */
const PLATFORM_TAGS: Record<string, string> = {
  twitch: 'tw', goodgame: 'gg', youtube: 'yt',
};

export function platformTag(platform: string): string {
  return PLATFORM_TAGS[platform] ?? 'gg';
}

/**
 * Role badges the app ships artwork for.
 *
 * A moderator and a channel owner exist on all three platforms, but only Twitch
 * publishes a picture of them: GoodGame and YouTube send the role and nothing
 * else, so in icons mode the same role drew a sword on one platform and the
 * letters MOD on the next. These are bundled rather than borrowed from Twitch's
 * badge CDN — that would put Twitch's branding on another platform's roles and
 * make a GoodGame badge depend on a mirror that the degraded scenario exists
 * because it goes down.
 *
 * Only the two roles the user sees everywhere. GoodGame's ADMIN and YouTube's
 * VER have no counterpart to match and stay text.
 */
const BUNDLED_BADGE_ICONS: Record<string, string> = {
  moderator: '../assets/badge-moderator.svg',
  broadcaster: '../assets/badge-broadcaster.svg',
};

/** The artwork to draw a badge with: the platform's own first, ours after. */
export function badgeIconPath(badge: Badge): string | null {
  return badge.url ?? BUNDLED_BADGE_ICONS[badge.kind] ?? null;
}

/** Real artwork where there is any, a coloured text chip otherwise. */
export function badgeRendering(badge: Badge, config: Config): 'image' | 'chip' {
  return config.badgeStyle === 'icons' && badgeIconPath(badge) ? 'image' : 'chip';
}

export function visibleBadges(msg: ChatMessage, config: Config): Badge[] {
  if (config.badgeStyle === 'off' || msg.kind !== 'chat') return [];
  return msg.badges;
}

/**
 * What separates a name from the line that follows it.
 *
 * A colon, except for the two cases where one would be wrong: an event about
 * the author rather than something they said — a `/me`, a membership — reads
 * as a sentence and takes a space, and a superchat sent with no text at all,
 * which is ordinary, would otherwise be left with a colon and nothing after it.
 */
export function nameSeparator(msg: ChatMessage): string {
  if (msg.action) return ' ';
  return msg.parts.length > 0 ? ':' : '';
}

/** The amount chip on a paid message: its text, and the colours to paint it in. */
export interface PaidChip { text: string; bg: string; ink: string }

/**
 * The amount a viewer paid, ready to draw — or null, which is every ordinary
 * message.
 *
 * The chip carries the amount as *text*, which is the whole point: YouTube's
 * tier colour is a second, redundant channel, so the line still says how much
 * was paid to somebody who cannot tell the tiers apart, and over a bright scene
 * where the chip's own background is the only thing keeping it legible. A
 * message that arrived with no colour is drawn in the same neutral grey an
 * unrecognised badge gets — the amount does not stop being the message.
 */
export function paidChip(msg: ChatMessage): PaidChip | null {
  const amount = (msg.paid?.amount ?? '').trim();
  if (!amount) return null;
  const swatch = msg.paid?.swatch;
  return { text: amount, bg: swatch?.bg ?? '#55607a', ink: swatch?.ink ?? '#ffffff' };
}

/** CSS custom properties derived from the settings. */
export function appearanceVars(config: Config): Record<string, string> {
  return {
    '--font-size': config.fontSize + 'px',
    '--font-weight': String(config.fontWeight),
    '--font-family': config.fontFamily,
    '--name-weight': config.boldNames ? '800' : 'var(--font-weight)',
    '--emote-size': Math.round(config.fontSize * config.emoteScale) + 'px',
    '--badge-size': Math.round(config.fontSize * 1.15) + 'px',
    '--bg': `rgba(10, 12, 18, ${config.bgOpacity})`,
    '--bg-hover': `rgba(10, 12, 18, ${config.hoverBgOpacity})`,
    '--fade': config.fadeDuration + 's',
  };
}

/**
 * How close to the bottom counts as "at the bottom", in pixels.
 *
 * The feed follows new messages only for someone who is already at the end of
 * it; a user who has scrolled back to read something must not be yanked away
 * mid-sentence. A couple of lines of slack, because a scroll position lands on
 * fractional pixels and a feed that stopped following after a one-pixel
 * rounding error would look broken.
 */
export const PIN_SLACK_PX = 24;

/** Whether the feed should follow new messages, given where it is scrolled. */
export function pinnedToBottom(
  view: { scrollHeight: number; clientHeight: number; scrollTop: number },
): boolean {
  return view.scrollHeight - view.clientHeight - view.scrollTop < PIN_SLACK_PX;
}

export interface SourceStatus { state: ConnectionState; detail: string }

export interface StatusDot {
  key: string;
  label: string;
  state: ConnectionState;
  /** Tooltip text; also what a screen reader gets, since the dot is a colour. */
  title: string;
}

/**
 * One dot per channel in the top bar, its colour carrying the state.
 *
 * The bar is chrome on an overlay, so it stays quieter than the chat it sits
 * above: the channel name is there but revealed on hover, and the same
 * "connected — …" line is already written into the chat itself. An empty list
 * shows nothing at all — the hint in the chat body covers that case.
 */
export function statusDots(
  sources: { key: string; platform: string; channel: string }[],
  states: Map<string, SourceStatus>,
): StatusDot[] {
  return sources.map((s) => {
    const st = states.get(s.key) ?? { state: 'connecting' as ConnectionState, detail: '' };
    const label = `${platformTag(s.platform)}/${s.channel}`;
    const detail = st.detail && st.state !== 'online' ? ` — ${st.detail}` : '';
    return { key: s.key, label, state: st.state, title: `${label} — ${st.state}${detail}` };
  });
}

export interface BarAlert {
  /** ok — say nothing at all; warn — some chat still flowing; down — none is. */
  level: 'ok' | 'warn' | 'down';
  text: string;
  title: string;
}

/**
 * What the bar says at rest about the connections as a whole.
 *
 * The bar is chrome on an overlay, so the healthy answer is *nothing*: green
 * dots are on screen every second of every session, carry no information the
 * arriving messages do not already carry, and spend permanent pixels over a
 * game to say "as expected". Only the exception is worth drawing, and drawing
 * it only then makes its appearance — not its colour — the signal.
 *
 * Two failures, because they are two different problems. Some channels down
 * while others still talk is easy to miss and rarely needs acting on; every
 * channel down means the feed has stopped, which is exactly the question a
 * user asks when chat goes quiet — "is nobody talking, or is this thing dead?"
 * The count answers the first, the wording answers the second, and neither
 * relies on telling amber from red over a bright game.
 */
export function barAlert(dots: StatusDot[]): BarAlert {
  const title = dots.map((d) => d.title).join('\n');
  // A channel that is not live is not a channel that has stopped: it is the
  // resting state of most channels most of the time, and counting it as a
  // failure would leave a permanent alert over the game for the ordinary case.
  // It is excluded from the *judgement* but not from the count, because the
  // count is about the row the user is looking at: "1 of 3 offline" with three
  // channels configured, never "1 of 2".
  const carrying = dots.filter((d) => d.state !== 'idle');
  const off = carrying.filter((d) => d.state !== 'online');
  // An empty channel list is legitimate — the hint in the chat body covers it.
  if (off.length === 0) return { level: 'ok', text: '', title };
  if (off.length < carrying.length) {
    return { level: 'warn', text: `${off.length} of ${dots.length} offline`, title };
  }
  return { level: 'down', text: dots.length === 1 ? 'offline' : 'all channels offline', title };
}

/**
 * What to say when nothing is connected. "No channels yet" and "none enabled"
 * are different problems and lead the user to different buttons.
 */
export function emptyHint(sources: SourceConfig[]): string {
  const named = sources.some((s) => s.channel);
  return named
    ? 'No channel enabled — open Settings and tick one.'
    : 'No channels yet — open Settings and add one.';
}

export function sourceDotClass(src: SourceConfig | undefined, status: SourceStatus | undefined): string {
  if (!src || src.enabled === false) return 'dot';
  if (status?.state === 'online') return 'dot on';
  if (status?.state === 'error') return 'dot err';
  return 'dot';
}

/** Which messages a removal request targets, given the rendered set. */
export function messagesToRemove(
  req: { ids?: string[]; platform?: string; channel?: string; user?: string; userId?: string; all?: boolean },
  rendered: { id: string; platform: string; channel: string; user: string; userId?: string }[],
): string[] {
  if (req.ids) return req.ids;
  // Moderation belongs to the channel it happened in. The same person can be
  // in several channels of one platform at once, and a ban in one says nothing
  // about the others — so both branches match the channel, not just the clear.
  const sameChannel = (m: { platform: string; channel: string }): boolean =>
    m.platform === req.platform && m.channel === req.channel;
  return rendered.filter((m) => {
    if (req.all) return sameChannel(m);
    // By the platform's own id where there is one, because a name is not
    // always the person: on YouTube display names are reusable, so a ban
    // matched by name takes the impersonated regular down with the troll.
    if (req.userId) return sameChannel(m) && m.userId === req.userId;
    if (req.user) return sameChannel(m) && m.user === req.user;
    return false;
  }).map((m) => m.id);
}
