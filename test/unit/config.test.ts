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
