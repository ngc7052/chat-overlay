import { clamp } from '../shared/clamp.js';
import type { BadgeStyle, Config, PlatformStyle, SourceConfig } from './types.js';

export const DEFAULT_CONFIG: Config = {
  // No channels out of the box — the user adds their own, and the list is then
  // persisted to config.json like every other setting.
  sources: [],
  bounds: { x: null, y: null, width: 420, height: 620 },
  locked: true,
  hidden: false,
  fontSize: 16,
  fontWeight: 600,
  fontFamily: "'Segoe UI', 'Inter', system-ui, sans-serif",
  opacity: 1,
  bgOpacity: 0,          // while locked: nothing behind the text by default
  hoverBgOpacity: 0.55,  // while unlocked and hovered, so the window can be found
  outline: true,
  showTimestamps: false,
  platformStyle: 'icon',
  badgeStyle: 'icons',
  boldNames: false,
  exactColors: true,
  showSystem: true,
  customCss: '',
  emotes: true,
  thirdPartyEmotes: true,
  emoteScale: 1.7,
  messageLifetime: 0,
  fadeDuration: 1.2,
  maxMessages: 120,
  hideCommands: false,
  ignoreList: [],
  hotkeyLock: 'Control+Alt+O',
  hotkeyHide: 'Control+Alt+H',
  autoCheckUpdates: true,
};

/** A config file written by an older build, before any migrations run. */
type RawConfig = Partial<Config> & {
  showBadges?: unknown;
  showPlatform?: unknown;
};

export function defaultConfig(): Config {
  return { ...DEFAULT_CONFIG, sources: [], bounds: { ...DEFAULT_CONFIG.bounds } };
}

/** Every numeric setting whose value a Config carries. */
type NumericKey = { [K in keyof Config]: Config[K] extends number ? K : never }[keyof Config];

/**
 * The range each numeric setting is allowed to hold, matching the `min`/`max`
 * its slider in `static/renderer/index.html` already enforces.
 *
 * config.json is a documented, hand-editable file, so these values arrive from
 * outside the UI as often as from it. Left unchecked, an opacity of 0 on a
 * locked overlay is a window that is running, on top, invisible and
 * click-through — and reloaded that way on every launch.
 */
const RANGES: Record<NumericKey, [number, number]> = {
  fontSize: [9, 42],
  fontWeight: [300, 800],
  opacity: [0.2, 1],
  bgOpacity: [0, 0.9],
  hoverBgOpacity: [0, 0.9],
  emoteScale: [1, 3],
  maxMessages: [10, 400],
  messageLifetime: [0, 120],
  // No slider of its own; it is the CSS fade a message leaves on. Anything
  // longer outlives the message it belongs to.
  fadeDuration: [0, 10],
};

// The window has no numeric control either — it is dragged and resized. These
// are the floors `window:resizeBy` keeps, and a ceiling no display exceeds.
const WIDTH_RANGE: [number, number] = [220, 10000];
const HEIGHT_RANGE: [number, number] = [120, 10000];

/**
 * A finite number bounded to `range`; anything else — a string, null, NaN,
 * Infinity, a missing key — falls back to the default rather than reaching the
 * window or the stylesheet as-is.
 */
function boundedNumber(value: unknown, range: [number, number], fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(value, range[0], range[1]);
}

/** Window coordinates are legitimately absent — "wherever it opens" is null. */
function coordinate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isSource(value: unknown): value is SourceConfig {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<SourceConfig>;
  const known = s.platform === 'twitch' || s.platform === 'goodgame' || s.platform === 'youtube';
  return known && typeof s.channel === 'string';
}

/**
 * Turn whatever is on disk into a usable Config: fill in defaults, apply the
 * migrations for settings that changed shape, and enforce the two invariants
 * the UI depends on.
 *
 * Kept free of `fs` and `electron` so the rules can be tested directly — these
 * are exactly the decisions that quietly corrupt someone's setup when wrong.
 */
export function normaliseConfig(raw: unknown): Config {
  const parsed: RawConfig = raw && typeof raw === 'object' ? (raw as RawConfig) : {};
  const config: Config = { ...defaultConfig(), ...parsed } as Config;

  const bounds: Partial<Config['bounds']> = parsed.bounds ?? {};
  config.bounds = {
    x: coordinate(bounds.x),
    y: coordinate(bounds.y),
    width: boundedNumber(bounds.width, WIDTH_RANGE, DEFAULT_CONFIG.bounds.width),
    height: boundedNumber(bounds.height, HEIGHT_RANGE, DEFAULT_CONFIG.bounds.height),
  };

  // Every numeric setting, held to the range its control offers. A config.json
  // edited by hand is expected — the README says where it lives — and a value
  // outside these makes the overlay unusable or unreachable.
  for (const key of Object.keys(RANGES) as NumericKey[]) {
    (config as Record<NumericKey, number>)[key] =
      boundedNumber(parsed[key], RANGES[key], DEFAULT_CONFIG[key]);
  }

  // An empty list is a legitimate state (fresh install, or the user removed
  // every channel) — it must never be silently repopulated.
  config.sources = Array.isArray(parsed.sources) ? parsed.sources.filter(isSource) : [];
  config.sources = config.sources.map((s) => ({
    platform: s.platform,
    channel: s.channel,
    enabled: s.enabled !== false,
  }));

  config.ignoreList = Array.isArray(parsed.ignoreList)
    ? parsed.ignoreList.filter((n): n is string => typeof n === 'string')
    : [];

  // showBadges (boolean) was replaced by badgeStyle ('icons'|'text'|'off').
  if (typeof parsed.showBadges === 'boolean') {
    if (parsed.showBadges === false) config.badgeStyle = 'off';
    delete (config as RawConfig).showBadges;
  }
  // showPlatform (boolean) was replaced by platformStyle ('icon'|'text'|'off').
  if (typeof parsed.showPlatform === 'boolean') {
    if (parsed.showPlatform === false) config.platformStyle = 'off';
    delete (config as RawConfig).showPlatform;
  }

  const badgeStyles: BadgeStyle[] = ['icons', 'text', 'off'];
  if (!badgeStyles.includes(config.badgeStyle)) config.badgeStyle = DEFAULT_CONFIG.badgeStyle;
  const platformStyles: PlatformStyle[] = ['icon', 'text', 'off'];
  if (!platformStyles.includes(config.platformStyle)) config.platformStyle = DEFAULT_CONFIG.platformStyle;

  // A locked overlay with nothing to show is an invisible, unreachable window —
  // start unlocked so Settings is actually reachable.
  if (!config.sources.some((s) => s.enabled && s.channel)) config.locked = false;

  return config;
}

/** Parse a config file's text; anything unreadable falls back to defaults. */
export function parseConfig(text: string | null | undefined): Config {
  if (typeof text !== 'string') return normaliseConfig(null);
  try {
    return normaliseConfig(JSON.parse(text));
  } catch {
    return normaliseConfig(null);
  }
}

/** Only these sources are worth opening a socket for. */
export function activeSources(config: Config): SourceConfig[] {
  return config.sources.filter((s) => s.enabled && s.channel.trim() !== '');
}
