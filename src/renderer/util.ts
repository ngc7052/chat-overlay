/** Colours, text splitting and small helpers used while rendering messages. */

export interface TextPart { type: 'text'; value: string }
export interface UrlPart { type: 'url'; value: string }
export interface EmotePart { type: 'emote'; url: string; name: string; fallback?: string }
export type MessagePart = TextPart | UrlPart | EmotePart;

export function hashCode(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

/** Deterministic, always-readable-on-dark colour for a nickname. */
export function nickColor(name: string): string {
  const hue = hashCode(String(name).toLowerCase()) % 360;
  return `hsl(${hue}, 72%, 68%)`;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1] as string, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h * 360, s, l };
}

/**
 * Twitch lets users pick very dark colours (#0000FF) that vanish over a game.
 * `exact` returns the colour Twitch actually sends (what the site shows);
 * otherwise anything below the floor is lifted, keeping its hue.
 */
export function readableColor(hex: string, fallbackName: string, exact?: boolean): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return nickColor(fallbackName || 'anon');
  if (exact) return '#' + String(hex).replace(/^#/, '').toLowerCase();
  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const L = Math.max(l, 0.62);
  const S = Math.max(s, 0.45);
  return `hsl(${Math.round(h)}, ${Math.round(S * 100)}%, ${Math.round(L * 100)}%)`;
}

/**
 * GoodGame sends a CSS class name rather than a colour, so the known ones are
 * mapped and anything else falls back to the nickname hash.
 */
const GG_COLORS: Record<string, string | null> = {
  simple: null,
  '': null,
  streamer: '#ffd479',
  moderator: '#ff6b7a',
  'streamer-helper': '#e8bb00',
  admin: '#ff8a5c',
  staff: '#c084fc',
  premium: '#f0b429',
  'premium-personal': '#f7a8d8',
  ggplus: '#5ce1e6',
  donat: '#7ef0a0',
};

export function ggColor(colorClass: unknown, name: string): string {
  const asHex = hexToRgb(String(colorClass ?? ''));
  if (asHex) return readableColor(String(colorClass), name);
  const mapped = GG_COLORS[String(colorClass ?? '').toLowerCase()];
  return mapped ? readableColor(mapped, name) : nickColor(name);
}

export function timeString(tsMs: number): string {
  const d = new Date(tsMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...args: A): void => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

/** Split a plain-text run into text / url parts. No HTML is ever produced. */
export function splitUrls(text: string): MessagePart[] {
  const out: MessagePart[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    out.push({ type: 'url', value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

/** A solid colour and the ink that stays readable on it. */
export interface Swatch { bg: string; ink: string }

/**
 * A platform's own tier colour, turned into something safe to paint on.
 *
 * YouTube sends its superchat colours as unsigned ARGB integers, and the tiers
 * span the whole range from a dark magenta to a bright yellow — so a fixed ink
 * is unreadable on half of them. The ink is chosen from the background's
 * relative luminance rather than taken from the `headerTextColor` YouTube
 * sends beside it, which arrives semi-transparent and would have to be
 * composited against a background this app is not drawing.
 *
 * The alpha byte is dropped: these are chips over arbitrary game footage, and
 * a translucent one is exactly the thing the feed's whole legibility story
 * exists to avoid.
 */
export function argbSwatch(value: unknown): Swatch | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const n = Math.round(value) >>> 0;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  // sRGB relative luminance, which is what tells a yellow tier from a red one.
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return { bg: `rgb(${r}, ${g}, ${b})`, ink: luminance > 0.36 ? '#0d1016' : '#ffffff' };
}
