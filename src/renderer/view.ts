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

export function platformIconPath(platform: string): string {
  return platform === 'twitch' ? '../assets/twitch.svg' : '../assets/goodgame.png';
}

/** Real artwork when the catalogue supplied it, a coloured text chip otherwise. */
export function badgeRendering(badge: Badge, config: Config): 'image' | 'chip' {
  return config.badgeStyle === 'icons' && badge.url ? 'image' : 'chip';
}

export function visibleBadges(msg: ChatMessage, config: Config): Badge[] {
  if (config.badgeStyle === 'off' || msg.kind !== 'chat') return [];
  return msg.badges;
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
    const label = `${s.platform === 'twitch' ? 'tw' : 'gg'}/${s.channel}`;
    const detail = st.detail && st.state !== 'online' ? ` — ${st.detail}` : '';
    return { key: s.key, label, state: st.state, title: `${label} — ${st.state}${detail}` };
  });
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
  req: { ids?: string[]; platform?: string; channel?: string; user?: string; all?: boolean },
  rendered: { id: string; platform: string; channel: string; user: string }[],
): string[] {
  if (req.ids) return req.ids;
  return rendered.filter((m) => {
    if (req.all) return m.platform === req.platform && m.channel === req.channel;
    if (req.user) return m.platform === req.platform && m.user === req.user;
    return false;
  }).map((m) => m.id);
}
