import { describe, expect, it, vi } from 'vitest';
import {
  argbSwatch, debounce, ggColor, hashCode, hexToRgb, nickColor, readableColor, rgbToHsl,
  splitUrls, timeString,
} from '../../src/renderer/util.js';

describe('hashCode', () => {
  it('is stable and non-negative', () => {
    expect(hashCode('abc')).toBe(hashCode('abc'));
    expect(hashCode('')).toBe(0);
    // A string whose running hash goes negative still yields a positive result.
    expect(hashCode('zzzzzzzzzzzz')).toBeGreaterThanOrEqual(0);
  });
});

describe('nickColor', () => {
  it('is deterministic and case-insensitive', () => {
    expect(nickColor('Nero')).toBe(nickColor('nero'));
  });

  it('produces a readable lightness for any name', () => {
    for (const name of ['a', 'bb', 'ccc', 'xqc', 'annieflowers']) {
      expect(nickColor(name)).toMatch(/^hsl\(\d+, 72%, 68%\)$/);
    }
  });
});

describe('hexToRgb', () => {
  it('accepts with and without the hash', () => {
    expect(hexToRgb('#ff8800')).toEqual({ r: 255, g: 136, b: 0 });
    expect(hexToRgb('ff8800')).toEqual({ r: 255, g: 136, b: 0 });
    expect(hexToRgb('  #FF8800 ')).toEqual({ r: 255, g: 136, b: 0 });
  });

  it('rejects anything that is not six hex digits', () => {
    expect(hexToRgb('#fff')).toBeNull();
    expect(hexToRgb('')).toBeNull();
    expect(hexToRgb('nope')).toBeNull();
  });
});

describe('rgbToHsl', () => {
  it('returns zero saturation for greys', () => {
    expect(rgbToHsl(128, 128, 128).s).toBe(0);
  });

  it('puts each primary on its own hue', () => {
    expect(Math.round(rgbToHsl(255, 0, 0).h)).toBe(0);
    expect(Math.round(rgbToHsl(0, 255, 0).h)).toBe(120);
    expect(Math.round(rgbToHsl(0, 0, 255).h)).toBe(240);
  });

  it('uses the other branch of the lightness formula for dark colours', () => {
    // l <= 0.5 exercises d / (max + min); a light colour takes the other path.
    expect(rgbToHsl(40, 0, 0).s).toBeGreaterThan(0);
    expect(rgbToHsl(255, 200, 200).s).toBeGreaterThan(0);
  });
});

describe('readableColor', () => {
  it('returns the exact colour when asked', () => {
    expect(readableColor('#0000ff', 'someone', true)).toBe('#0000ff');
    expect(readableColor('0000FF', 'someone', true)).toBe('#0000ff');
  });

  it('lifts a colour too dark to read over a game', () => {
    const lifted = readableColor('#0000ff', 'someone', false);
    const [, l] = /(\d+)%\)$/.exec(lifted) ?? [];
    expect(Number(l)).toBeGreaterThanOrEqual(62);
  });

  it('leaves an already-bright colour alone', () => {
    expect(readableColor('#ffdd88', 'someone')).toMatch(/^hsl\(/);
  });

  it('falls back to the nickname hash when the colour is unusable', () => {
    expect(readableColor('', 'nero')).toBe(nickColor('nero'));
    expect(readableColor('', '')).toBe(nickColor('anon'));
  });
});

describe('ggColor', () => {
  it('maps GoodGame class names to colours', () => {
    expect(ggColor('streamer', 'x')).toBe(readableColor('#ffd479', 'x'));
    expect(ggColor('premium-personal', 'x')).toBe(readableColor('#f7a8d8', 'x'));
  });

  it('is case-insensitive about the class name', () => {
    expect(ggColor('STREAMER', 'x')).toBe(ggColor('streamer', 'x'));
  });

  it('hashes the nickname for the default classes', () => {
    expect(ggColor('simple', 'nero')).toBe(nickColor('nero'));
    expect(ggColor('', 'nero')).toBe(nickColor('nero'));
    expect(ggColor(undefined, 'nero')).toBe(nickColor('nero'));
    expect(ggColor('unknown-class', 'nero')).toBe(nickColor('nero'));
  });

  it('accepts a real hex value if one ever arrives', () => {
    expect(ggColor('#123456', 'x')).toBe(readableColor('#123456', 'x'));
  });
});

describe('timeString', () => {
  it('zero-pads to HH:MM', () => {
    const d = new Date(2026, 0, 2, 3, 4);
    expect(timeString(d.getTime())).toBe('03:04');
  });
});

describe('splitUrls', () => {
  it('returns a single text part when there is no url', () => {
    expect(splitUrls('hello there')).toEqual([{ type: 'text', value: 'hello there' }]);
  });

  it('splits text around a url', () => {
    expect(splitUrls('see https://a.b/c ok')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'url', value: 'https://a.b/c' },
      { type: 'text', value: ' ok' },
    ]);
  });

  it('handles a url at the very start and end', () => {
    expect(splitUrls('https://a.b')).toEqual([{ type: 'url', value: 'https://a.b' }]);
    expect(splitUrls('x https://a.b')).toEqual([
      { type: 'text', value: 'x ' },
      { type: 'url', value: 'https://a.b' },
    ]);
  });

  it('finds several urls', () => {
    const parts = splitUrls('http://a.b and https://c.d');
    expect(parts.filter((p) => p.type === 'url')).toHaveLength(2);
  });

  it('does not carry lastIndex between calls', () => {
    splitUrls('https://a.b/first');
    expect(splitUrls('https://a.b/second')).toEqual([
      { type: 'url', value: 'https://a.b/second' },
    ]);
  });

  it('returns nothing for an empty string', () => {
    expect(splitUrls('')).toEqual([]);
  });
});

describe('debounce', () => {
  it('only runs once for a burst, with the last arguments', () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const d = debounce(spy, 100);
    d('a');
    d('b');
    d('c');
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('c');
    vi.useRealTimers();
  });
});

describe('argbSwatch', () => {
  /*
   * The numbers are the ones YouTube actually sends, read off a live channel:
   * an unsigned ARGB integer per superchat tier.
   */
  it('drops the alpha and keeps the colour', () => {
    // 0xFFC2185B — the magenta of the ¥5,000 tier.
    expect(argbSwatch(4290910299)?.bg).toBe('rgb(194, 24, 91)');
  });

  it('picks ink that can be read on a dark tier and on a bright one', () => {
    // The dark tiers take white; a bright one (0xFFFFCA28) does not, which is
    // the whole reason the ink is chosen rather than fixed.
    expect(argbSwatch(4290910299)?.ink).toBe('#ffffff');
    expect(argbSwatch(4294953512)?.ink).toBe('#0d1016');
    // And the two ends of the range, which no tier uses but a future one might.
    expect(argbSwatch(4278190080)?.ink).toBe('#ffffff');
    expect(argbSwatch(4294967295)?.ink).toBe('#0d1016');
  });

  it('has no colour to offer when none arrived', () => {
    expect(argbSwatch(undefined)).toBeNull();
    expect(argbSwatch('#ff0000')).toBeNull();
    expect(argbSwatch(Number.NaN)).toBeNull();
  });
});
