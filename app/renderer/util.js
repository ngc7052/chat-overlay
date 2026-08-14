'use strict';

/* Small shared helpers. Loaded as a classic script; exports onto window.U. */

const U = (() => {
  function hashCode(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
  }

  /** Deterministic, always-readable-on-dark colour for a nickname. */
  function nickColor(name) {
    const hue = hashCode(String(name).toLowerCase()) % 360;
    return `hsl(${hue}, 72%, 68%)`;
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHsl(r, g, b) {
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
  function readableColor(hex, fallbackName, exact) {
    const rgb = hexToRgb(hex);
    if (!rgb) return nickColor(fallbackName || 'anon');
    if (exact) return '#' + String(hex).replace(/^#/, '').toLowerCase();
    const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
    const L = Math.max(l, 0.62);
    const S = Math.max(s, 0.45);
    return `hsl(${Math.round(h)}, ${Math.round(S * 100)}%, ${Math.round(L * 100)}%)`;
  }

  /** GoodGame sends a CSS class name, not a colour. Map the known ones. */
  const GG_COLORS = {
    simple: null,               // default -> hash by nickname
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

  function ggColor(colorClass, name) {
    const direct = hexToRgb(colorClass);
    if (direct) return readableColor(colorClass, name);
    const mapped = GG_COLORS[String(colorClass || '').toLowerCase()];
    return mapped ? readableColor(mapped, name) : nickColor(name);
  }

  function timeString(tsMs) {
    const d = new Date(tsMs);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

  /** Split a plain-text run into text / url parts (no HTML is ever produced). */
  function splitUrls(text) {
    const out = [];
    let last = 0;
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text)) !== null) {
      if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
      out.push({ type: 'url', value: m[0] });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
    return out;
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  return {
    hashCode,
    nickColor,
    readableColor,
    ggColor,
    timeString,
    debounce,
    splitUrls,
    clamp,
  };
})();

window.U = U;
