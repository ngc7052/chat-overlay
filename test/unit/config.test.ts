import { describe, expect, it } from 'vitest';
import { activeSources, defaultConfig, normaliseConfig, parseConfig } from '../../src/main/config.js';

describe('defaultConfig', () => {
  it('ships with no channels', () => {
    expect(defaultConfig().sources).toEqual([]);
  });

  it('hands out a fresh object each time', () => {
    const a = defaultConfig();
    a.sources.push({ platform: 'twitch', channel: 'x', enabled: true });
    expect(defaultConfig().sources).toEqual([]);
    expect(defaultConfig().bounds).not.toBe(a.bounds);
  });
});

describe('normaliseConfig', () => {
  it('fills in defaults for anything absent', () => {
    const c = normaliseConfig({});
    expect(c.fontSize).toBe(16);
    expect(c.hotkeyLock).toBe('Control+Alt+O');
  });

  it('defaults to no backdrop when locked, but a visible one on hover', () => {
    const c = normaliseConfig({});
    expect(c.bgOpacity).toBe(0);
    expect(c.hoverBgOpacity).toBeGreaterThan(0);
  });

  it('keeps the two backdrops independent', () => {
    const c = normaliseConfig({ bgOpacity: 0.3, hoverBgOpacity: 0.9 });
    expect(c.bgOpacity).toBe(0.3);
    expect(c.hoverBgOpacity).toBe(0.9);
  });

  it('copes with junk instead of an object', () => {
    expect(normaliseConfig(null).sources).toEqual([]);
    expect(normaliseConfig('nope').sources).toEqual([]);
    expect(normaliseConfig(42).fontSize).toBe(16);
  });

  it('keeps the user values it is given', () => {
    const c = normaliseConfig({ fontSize: 30, customCss: '.msg{}' });
    expect(c.fontSize).toBe(30);
    expect(c.customCss).toBe('.msg{}');
  });

  it('merges bounds rather than replacing them wholesale', () => {
    const c = normaliseConfig({ bounds: { x: 10, y: 20 } });
    expect(c.bounds).toEqual({ x: 10, y: 20, width: 420, height: 620 });
  });

  it('never repopulates an empty channel list', () => {
    // Restoring defaults here would resurrect channels the user deleted.
    expect(normaliseConfig({ sources: [] }).sources).toEqual([]);
  });

  it('drops entries that are not usable sources', () => {
    const c = normaliseConfig({
      sources: [
        { platform: 'twitch', channel: 'ok', enabled: true },
        { platform: 'myspace', channel: 'x' },
        { channel: 'no platform' },
        null,
        'nope',
      ],
    });
    expect(c.sources).toEqual([{ platform: 'twitch', channel: 'ok', enabled: true }]);
  });

  /**
   * `isSource` was widened for YouTube, and nothing else in the suite pins it:
   * a row the app can no longer load is a channel the user silently loses on
   * the next save.
   */
  it('keeps a row for every platform the app can read', () => {
    const c = normaliseConfig({
      sources: [
        { platform: 'twitch', channel: 'a', enabled: true },
        { platform: 'goodgame', channel: 'b', enabled: true },
        { platform: 'youtube', channel: '@c', enabled: true },
      ],
    });
    expect(c.sources.map((s) => s.platform)).toEqual(['twitch', 'goodgame', 'youtube']);
    expect(c.sources[2]).toEqual({ platform: 'youtube', channel: '@c', enabled: true });
  });

  it('treats a source without an explicit flag as enabled', () => {
    const c = normaliseConfig({ sources: [{ platform: 'twitch', channel: 'x' }] });
    expect(c.sources[0]?.enabled).toBe(true);
  });

  it('replaces a non-array source list', () => {
    expect(normaliseConfig({ sources: 'x' }).sources).toEqual([]);
  });

  it('keeps only strings in the ignore list', () => {
    expect(normaliseConfig({ ignoreList: ['bot', 5, null] }).ignoreList).toEqual(['bot']);
    expect(normaliseConfig({ ignoreList: 'bot' }).ignoreList).toEqual([]);
  });

  describe('numeric ranges', () => {
    // config.json is a documented file the README points at, so a hand edit —
    // or a half-written file — is an ordinary thing to load, not an exotic one.
    const corrupt = {
      opacity: 0,
      fontSize: -50,
      maxMessages: 0,
      emoteScale: 900,
      fadeDuration: 'nope',
      bgOpacity: 5,
      locked: true,
      sources: [{ platform: 'twitch', channel: 'x', enabled: true }],
    };

    it('leaves a config that is already in range exactly as it found it', () => {
      const valid = {
        fontSize: 24, fontWeight: 400, opacity: 0.8, bgOpacity: 0.4,
        hoverBgOpacity: 0.6, emoteScale: 2.2, maxMessages: 250,
        messageLifetime: 30, fadeDuration: 0.5,
        bounds: { x: 100, y: 50, width: 600, height: 700 },
      };
      const c = normaliseConfig(valid);
      for (const [key, value] of Object.entries(valid)) {
        expect(c[key as keyof typeof valid]).toEqual(value);
      }
    });

    it('never leaves a locked overlay invisible', () => {
      // opacity 0 while locked is a window that is running, on top, invisible
      // AND click-through — with no way to reach Settings and change it back.
      const c = normaliseConfig(corrupt);
      expect(c.locked).toBe(true);
      expect(c.opacity).toBe(0.2);
    });

    it('pulls every out-of-range number back to its slider bounds', () => {
      const c = normaliseConfig(corrupt);
      expect(c.fontSize).toBe(9);        // min 9
      expect(c.maxMessages).toBe(10);    // min 10, not 0 — 0 trims every arrival
      expect(c.emoteScale).toBe(3);      // max 3
      expect(c.bgOpacity).toBe(0.9);     // max 0.9
    });

    it('replaces a non-number with the default instead of passing it through', () => {
      // fadeDuration reaches CSS as `--fade: <value>s`; a string makes "nopes".
      expect(normaliseConfig(corrupt).fadeDuration).toBe(1.2);
      expect(normaliseConfig({ fontSize: '30' }).fontSize).toBe(16);
      expect(normaliseConfig({ opacity: null }).opacity).toBe(1);
      expect(normaliseConfig({ maxMessages: NaN }).maxMessages).toBe(120);
      expect(normaliseConfig({ emoteScale: Infinity }).emoteScale).toBe(1.7);
      expect(normaliseConfig({ fontWeight: { big: true } }).fontWeight).toBe(600);
    });

    it('bounds the remaining settings too', () => {
      expect(normaliseConfig({ fontSize: 999 }).fontSize).toBe(42);
      expect(normaliseConfig({ fontWeight: 100 }).fontWeight).toBe(300);
      expect(normaliseConfig({ fontWeight: 900 }).fontWeight).toBe(800);
      expect(normaliseConfig({ opacity: 4 }).opacity).toBe(1);
      expect(normaliseConfig({ bgOpacity: -1 }).bgOpacity).toBe(0);
      expect(normaliseConfig({ hoverBgOpacity: -1 }).hoverBgOpacity).toBe(0);
      expect(normaliseConfig({ hoverBgOpacity: 3 }).hoverBgOpacity).toBe(0.9);
      expect(normaliseConfig({ emoteScale: 0 }).emoteScale).toBe(1);
      expect(normaliseConfig({ maxMessages: 9999 }).maxMessages).toBe(400);
      expect(normaliseConfig({ messageLifetime: -5 }).messageLifetime).toBe(0);
      expect(normaliseConfig({ messageLifetime: 900 }).messageLifetime).toBe(120);
      expect(normaliseConfig({ fadeDuration: -1 }).fadeDuration).toBe(0);
      expect(normaliseConfig({ fadeDuration: 60 }).fadeDuration).toBe(10);
    });

    it('keeps the window openable whatever the bounds say', () => {
      // A grabbable window at the resize floor, not a zero-sized one — and an
      // unreadable coordinate means "wherever it opens", which is null.
      expect(normaliseConfig({ bounds: { x: 'left', y: null, width: -8, height: 0 } }).bounds)
        .toEqual({ x: null, y: null, width: 220, height: 120 });
      expect(normaliseConfig({ bounds: { width: 'wide', height: null } }).bounds)
        .toEqual({ x: null, y: null, width: 420, height: 620 });
      expect(normaliseConfig({ bounds: 'nope' }).bounds)
        .toEqual({ x: null, y: null, width: 420, height: 620 });
    });

    it('accepts negative window coordinates — a second display is to the left', () => {
      expect(normaliseConfig({ bounds: { x: -1200, y: -40 } }).bounds)
        .toMatchObject({ x: -1200, y: -40 });
    });
  });

  describe('migrations', () => {
    it('turns showBadges:false into badgeStyle off', () => {
      const c = normaliseConfig({ showBadges: false });
      expect(c.badgeStyle).toBe('off');
      expect('showBadges' in c).toBe(false);
    });

    it('leaves badgeStyle at the default when showBadges was true', () => {
      const c = normaliseConfig({ showBadges: true });
      expect(c.badgeStyle).toBe('icons');
      expect('showBadges' in c).toBe(false);
    });

    it('turns showPlatform:false into platformStyle off', () => {
      const c = normaliseConfig({ showPlatform: false });
      expect(c.platformStyle).toBe('off');
      expect('showPlatform' in c).toBe(false);
    });

    it('leaves platformStyle at the default when showPlatform was true', () => {
      const c = normaliseConfig({ showPlatform: true });
      expect(c.platformStyle).toBe('icon');
    });

    it('ignores the old keys when they are not booleans', () => {
      const c = normaliseConfig({ showBadges: 'yes', showPlatform: 1 });
      expect(c.badgeStyle).toBe('icons');
      expect(c.platformStyle).toBe('icon');
    });

    it('repairs an unrecognised style value', () => {
      const c = normaliseConfig({ badgeStyle: 'sparkles', platformStyle: 'holograms' });
      expect(c.badgeStyle).toBe('icons');
      expect(c.platformStyle).toBe('icon');
    });
  });

  describe('the unreachable-window rule', () => {
    it('starts unlocked when nothing is enabled', () => {
      // A locked overlay showing nothing is invisible and has no way back.
      expect(normaliseConfig({ locked: true, sources: [] }).locked).toBe(false);
      expect(normaliseConfig({
        locked: true,
        sources: [{ platform: 'twitch', channel: 'x', enabled: false }],
      }).locked).toBe(false);
      expect(normaliseConfig({
        locked: true,
        sources: [{ platform: 'twitch', channel: '', enabled: true }],
      }).locked).toBe(false);
    });

    it('honours locked once a channel is actually enabled', () => {
      expect(normaliseConfig({
        locked: true,
        sources: [{ platform: 'twitch', channel: 'x', enabled: true }],
      }).locked).toBe(true);
    });
  });
});

describe('parseConfig', () => {
  it('reads a stored config', () => {
    expect(parseConfig('{"fontSize":24}').fontSize).toBe(24);
  });

  it('falls back to defaults for missing or corrupt files', () => {
    expect(parseConfig(null).fontSize).toBe(16);
    expect(parseConfig(undefined).fontSize).toBe(16);
    expect(parseConfig('{ not json').fontSize).toBe(16);
  });
});

describe('activeSources', () => {
  it('keeps only enabled channels with a name', () => {
    const config = normaliseConfig({
      sources: [
        { platform: 'twitch', channel: 'a', enabled: true },
        { platform: 'twitch', channel: 'b', enabled: false },
        { platform: 'goodgame', channel: '  ', enabled: true },
      ],
    });
    expect(activeSources(config).map((s) => s.channel)).toEqual(['a']);
  });
});
