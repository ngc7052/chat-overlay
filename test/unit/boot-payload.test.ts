import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  choosePayload, createPayloadStore, MAX_TRIALS, pathsFor, REQUIRED_FILES, STAGED_MARKER,
  type Paths,
} from '../../src/boot/payload.js';

describe('choosePayload', () => {
  const base = { bundledVersion: '1.0.0', state: {}, recovering: false };

  it('runs the bundled payload when nothing is staged', () => {
    expect(choosePayload({ ...base, stagedVersion: null }))
      .toEqual({ use: 'bundled', reason: 'no-staged' });
  });

  it('ignores a staged payload that is not newer', () => {
    expect(choosePayload({ ...base, stagedVersion: '1.0.0' }))
      .toEqual({ use: 'bundled', reason: 'not-newer' });
    expect(choosePayload({ ...base, stagedVersion: '0.9.0' }))
      .toEqual({ use: 'bundled', reason: 'not-newer' });
  });

  it('runs a newer staged payload and counts the attempt', () => {
    expect(choosePayload({ ...base, stagedVersion: '1.0.1' }))
      .toEqual({ use: 'staged', trials: 1 });
  });

  it('carries on counting attempts for the same version', () => {
    expect(choosePayload({
      ...base, stagedVersion: '1.0.1', state: { version: '1.0.1', trials: 2 },
    })).toEqual({ use: 'staged', trials: 3 });
  });

  it('starts the count again when the staged version changed', () => {
    expect(choosePayload({
      ...base, stagedVersion: '1.0.2', state: { version: '1.0.1', trials: 2 },
    })).toEqual({ use: 'staged', trials: 1 });
  });

  it('gives up after too many failed launches', () => {
    expect(choosePayload({
      ...base, stagedVersion: '1.0.1', state: { version: '1.0.1', trials: MAX_TRIALS },
    })).toEqual({ use: 'bundled', reason: 'too-many-trials' });
  });

  it('never runs a version that was already thrown out', () => {
    expect(choosePayload({
      ...base,
      stagedVersion: '1.0.1',
      state: { quarantined: { version: '1.0.1', reason: 'broke', at: '', removed: true } },
    })).toEqual({ use: 'bundled', reason: 'blocked' });
  });

  it('still runs a different version after a quarantine', () => {
    expect(choosePayload({
      ...base,
      stagedVersion: '1.0.2',
      state: { quarantined: { version: '1.0.1', reason: 'broke', at: '', removed: true } },
    })).toEqual({ use: 'staged', trials: 1 });
  });

  it('falls back to bundled on the relaunch after a crash', () => {
    // Without this the app could crash-loop between the two payloads.
    expect(choosePayload({ ...base, stagedVersion: '1.0.1', recovering: true }))
      .toEqual({ use: 'bundled', reason: 'recovering' });
  });
});

/* ------------------------------------------------------------------------- */

describe('createPayloadStore', () => {
  let tmp: string;
  let paths: Paths;
  let store: ReturnType<typeof createPayloadStore>;

  const writePayload = (dir: string, version: string, complete = true) => {
    fs.mkdirSync(path.join(dir, 'renderer'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version }));
    if (complete) {
      for (const f of REQUIRED_FILES) {
        const dest = path.join(dir, f);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (!fs.existsSync(dest)) fs.writeFileSync(dest, 'x');
      }
    }
  };

  const markComplete = (dir: string) => fs.writeFileSync(path.join(dir, STAGED_MARKER), '{}');

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-boot-'));
    paths = pathsFor(path.join(tmp, 'userData'), path.join(tmp, 'app'));
    fs.mkdirSync(paths.userData, { recursive: true });
    store = createPayloadStore(paths);
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  describe('readVersion', () => {
    it('reads a version file', () => {
      writePayload(paths.bundledDir, '1.2.3');
      expect(store.readVersion(paths.bundledDir)).toBe('1.2.3');
    });

    it('returns null for missing, corrupt or malformed files', () => {
      expect(store.readVersion(path.join(tmp, 'nope'))).toBeNull();
      fs.mkdirSync(paths.stagedDir, { recursive: true });
      fs.writeFileSync(path.join(paths.stagedDir, 'version.json'), 'not json');
      expect(store.readVersion(paths.stagedDir)).toBeNull();
      fs.writeFileSync(path.join(paths.stagedDir, 'version.json'), '{"version":5}');
      expect(store.readVersion(paths.stagedDir)).toBeNull();
    });
  });

  describe('isComplete', () => {
    it('requires every file the app needs to start', () => {
      writePayload(paths.stagedDir, '1.0.1');
      expect(store.isComplete(paths.stagedDir)).toBe(true);
      fs.rmSync(path.join(paths.stagedDir, 'preload.js'));
      expect(store.isComplete(paths.stagedDir)).toBe(false);
    });
  });

  describe('state', () => {
    it('round-trips', () => {
      store.writeState({ version: '1.0.1', trials: 2 });
      expect(store.readState()).toEqual({ version: '1.0.1', trials: 2 });
    });

    it('treats a missing or corrupt state file as empty', () => {
      expect(store.readState()).toEqual({});
      fs.writeFileSync(paths.stateFile, 'not json');
      expect(store.readState()).toEqual({});
      fs.writeFileSync(paths.stateFile, 'null');
      expect(store.readState()).toEqual({});
    });

    it('reports the quarantined version when there is one', () => {
      expect(store.quarantinedVersion()).toBeNull();
      store.writeState({ quarantined: { version: '1.0.1', reason: 'x', at: '', removed: true } });
      expect(store.quarantinedVersion()).toBe('1.0.1');
      store.writeState({ quarantined: { version: null, reason: 'x', at: '', removed: true } });
      expect(store.quarantinedVersion()).toBeNull();
    });
  });

  describe('stagedVersion', () => {
    it('returns the version of a complete payload', () => {
      writePayload(paths.stagedDir, '1.0.1');
      expect(store.stagedVersion()).toBe('1.0.1');
    });

    it('returns null and clears away an incomplete one', () => {
      // A half-deleted or half-renamed directory must never be a candidate.
      fs.mkdirSync(paths.stagedDir, { recursive: true });
      fs.writeFileSync(path.join(paths.stagedDir, 'main.js'), 'x');
      expect(store.stagedVersion()).toBeNull();
      expect(fs.existsSync(paths.stagedDir)).toBe(false);
    });

    it('returns null when nothing is staged at all', () => {
      expect(store.stagedVersion()).toBeNull();
    });
  });

  describe('promoteIncoming', () => {
    it('does nothing when there is no incoming directory', () => {
      expect(store.promoteIncoming()).toBe('none');
    });

    it('installs a complete incoming payload', () => {
      writePayload(paths.incomingDir, '1.0.1');
      markComplete(paths.incomingDir);
      expect(store.promoteIncoming()).toBe('installed');
      expect(store.readVersion(paths.stagedDir)).toBe('1.0.1');
      expect(fs.existsSync(paths.incomingDir)).toBe(false);
    });

    it('replaces an older staged payload', () => {
      writePayload(paths.stagedDir, '1.0.1');
      writePayload(paths.incomingDir, '1.0.2');
      markComplete(paths.incomingDir);
      expect(store.promoteIncoming()).toBe('installed');
      expect(store.readVersion(paths.stagedDir)).toBe('1.0.2');
    });

    it('discards an incoming payload with no completion marker', () => {
      // The marker is written last, so its absence means an interrupted download.
      writePayload(paths.incomingDir, '1.0.1');
      expect(store.promoteIncoming()).toBe('discarded');
      expect(fs.existsSync(paths.incomingDir)).toBe(false);
      expect(fs.existsSync(paths.stagedDir)).toBe(false);
    });

    it('discards an incoming payload missing required files', () => {
      fs.mkdirSync(paths.incomingDir, { recursive: true });
      fs.writeFileSync(path.join(paths.incomingDir, 'version.json'), '{"version":"1.0.1"}');
      markComplete(paths.incomingDir);
      expect(store.promoteIncoming()).toBe('discarded');
    });

    it('discards an incoming payload with no version', () => {
      fs.mkdirSync(paths.incomingDir, { recursive: true });
      for (const f of REQUIRED_FILES.filter((f) => f !== 'version.json')) {
        const dest = path.join(paths.incomingDir, f);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'x');
      }
      markComplete(paths.incomingDir);
      expect(store.promoteIncoming()).toBe('discarded');
    });

    it('discards an incoming payload no newer than what is staged', () => {
      writePayload(paths.stagedDir, '1.0.2');
      writePayload(paths.incomingDir, '1.0.1');
      markComplete(paths.incomingDir);
      expect(store.promoteIncoming()).toBe('discarded');
      expect(store.readVersion(paths.stagedDir)).toBe('1.0.2');
    });

    it('lets the user retry a version that was quarantined', () => {
      store.writeState({ quarantined: { version: '1.0.1', reason: 'x', at: '', removed: true } });
      writePayload(paths.incomingDir, '1.0.1');
      markComplete(paths.incomingDir);
      expect(store.promoteIncoming()).toBe('installed');
      expect(store.quarantinedVersion()).toBeNull();
    });

    it('keeps an unrelated quarantine record', () => {
      store.writeState({ quarantined: { version: '0.9.9', reason: 'x', at: '', removed: true } });
      writePayload(paths.incomingDir, '1.0.1');
      markComplete(paths.incomingDir);
      store.promoteIncoming();
      expect(store.quarantinedVersion()).toBe('0.9.9');
    });

    it('reuses a fresh -old name when the previous one will not delete', () => {
      writePayload(paths.stagedDir, '1.0.1');
      writePayload(paths.incomingDir, '1.0.2');
      markComplete(paths.incomingDir);
      // A leftover -old that cannot be removed must not break the rename.
      const oldDir = paths.stagedDir + '-old';
      const blockingStore = createPayloadStore(paths, {
        ...fs,
        rmSync: ((p: string, opts: object) => {
          if (p === oldDir) return;                 // pretend the delete failed
          return fs.rmSync(p, opts as never);
        }) as typeof fs.rmSync,
      });
      fs.mkdirSync(oldDir, { recursive: true });
      expect(blockingStore.promoteIncoming()).toBe('installed');
      expect(blockingStore.readVersion(paths.stagedDir)).toBe('1.0.2');
    });

    it('puts the old payload back when the install rename fails', () => {
      writePayload(paths.stagedDir, '1.0.1');
      writePayload(paths.incomingDir, '1.0.2');
      markComplete(paths.incomingDir);
      const failing = createPayloadStore(paths, {
        ...fs,
        renameSync: ((from: string, to: string) => {
          if (from === paths.incomingDir) throw new Error('EPERM');
          return fs.renameSync(from, to);
        }) as typeof fs.renameSync,
      });
      expect(failing.promoteIncoming()).toBe('failed');
      // The launch still has a working payload.
      expect(failing.readVersion(paths.stagedDir)).toBe('1.0.1');
    });
  });

  describe('quarantine', () => {
    it('moves the payload aside and records why', () => {
      writePayload(paths.stagedDir, '1.0.1');
      store.quarantine('1.0.1', 'threw on load', '2026-01-01T00:00:00.000Z');
      expect(fs.existsSync(paths.stagedDir)).toBe(false);
      expect(fs.existsSync(paths.stagedDir + '-broken')).toBe(true);
      expect(store.readState().quarantined).toEqual({
        version: '1.0.1', reason: 'threw on load', at: '2026-01-01T00:00:00.000Z', removed: true,
      });
    });

    it('replaces an earlier quarantined copy', () => {
      fs.mkdirSync(paths.stagedDir + '-broken', { recursive: true });
      fs.writeFileSync(path.join(paths.stagedDir + '-broken', 'old.txt'), 'x');
      writePayload(paths.stagedDir, '1.0.1');
      store.quarantine('1.0.1', 'again', '');
      expect(fs.existsSync(path.join(paths.stagedDir + '-broken', 'old.txt'))).toBe(false);
    });

    it('still records the version when the directory cannot be moved', () => {
      // The record alone keeps the version out, even if the files survive.
      writePayload(paths.stagedDir, '1.0.1');
      const stubborn = createPayloadStore(paths, {
        ...fs,
        renameSync: (() => { throw new Error('EBUSY'); }) as typeof fs.renameSync,
        rmSync: (() => { throw new Error('EBUSY'); }) as typeof fs.rmSync,
      });
      stubborn.quarantine('1.0.1', 'locked', '');
      expect(stubborn.readState().quarantined).toMatchObject({ version: '1.0.1', removed: false });
    });
  });

  describe('removeLeftovers', () => {
    it('clears -old directories from earlier launches', () => {
      fs.mkdirSync(paths.stagedDir + '-old', { recursive: true });
      fs.mkdirSync(paths.stagedDir + '-old-123', { recursive: true });
      fs.mkdirSync(path.join(paths.userData, 'keep-me'), { recursive: true });
      store.removeLeftovers();
      expect(fs.existsSync(paths.stagedDir + '-old')).toBe(false);
      expect(fs.existsSync(paths.stagedDir + '-old-123')).toBe(false);
      expect(fs.existsSync(path.join(paths.userData, 'keep-me'))).toBe(true);
    });

    it('copes with userData not existing yet', () => {
      const fresh = createPayloadStore(pathsFor(path.join(tmp, 'nope'), path.join(tmp, 'app')));
      expect(() => fresh.removeLeftovers()).not.toThrow();
    });
  });

  describe('writeState', () => {
    it('swallows a write failure rather than crashing the launch', () => {
      const broken = createPayloadStore(paths, {
        ...fs,
        writeFileSync: (() => { throw new Error('EROFS'); }) as typeof fs.writeFileSync,
      });
      expect(() => broken.writeState({ trials: 1 })).not.toThrow();
    });
  });
});

describe('pathsFor', () => {
  it('derives every path from userData and the app directory', () => {
    const p = pathsFor('/data', '/app');
    expect(p.stagedDir).toBe(path.join('/data', 'payload'));
    expect(p.incomingDir).toBe(path.join('/data', 'payload') + '-new');
    expect(p.bundledDir).toBe(path.join('/app', 'payload'));
    expect(p.stateFile).toBe(path.join('/data', 'payload-state.json'));
  });
});
