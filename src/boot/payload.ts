import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { compareVersions } from '../shared/version.js';

/*
 * Payload selection and promotion — the logic behind boot.ts.
 *
 * Kept separate from the Electron entry point so every branch can be exercised
 * against a real temporary directory. These decisions are what stand between a
 * bad release and a bricked install, so "probably right" is not good enough.
 */

export const MAX_TRIALS = 3;
export const STAGED_MARKER = '.staged';
export const REQUIRED_FILES = ['main.js', 'preload.js', 'version.json', 'renderer/index.html'];

export interface Paths {
  userData: string;
  bundledDir: string;
  stagedDir: string;
  incomingDir: string;
  stateFile: string;
}

export interface QuarantineRecord {
  version: string | null;
  reason: string;
  at: string;
  removed: boolean;
}

export interface BootState {
  version?: string;
  trials?: number;
  quarantined?: QuarantineRecord;
}

type Fs = Pick<typeof nodeFs,
  'existsSync' | 'readFileSync' | 'writeFileSync' | 'renameSync' | 'rmSync' | 'readdirSync'>;

export function pathsFor(userData: string, appDir: string): Paths {
  const stagedDir = nodePath.join(userData, 'payload');
  return {
    userData,
    bundledDir: nodePath.join(appDir, 'payload'),
    stagedDir,
    incomingDir: stagedDir + '-new',
    stateFile: nodePath.join(userData, 'payload-state.json'),
  };
}

/* ------------------------------------------------------------- decision ---- */

export type Choice =
  | { use: 'bundled'; reason: 'no-staged' | 'not-newer' | 'blocked' | 'recovering' | 'too-many-trials' }
  | { use: 'staged'; trials: number };

/**
 * Which payload should this launch run?
 *
 * Pure on purpose: given the two versions, the saved state and whether we are
 * recovering from a crash, the answer is fixed — no filesystem needed to
 * confirm it.
 */
export function choosePayload(input: {
  bundledVersion: string;
  stagedVersion: string | null;
  state: BootState;
  recovering: boolean;
  maxTrials?: number;
}): Choice {
  const { bundledVersion, stagedVersion, state, recovering } = input;
  const maxTrials = input.maxTrials ?? MAX_TRIALS;

  if (!stagedVersion) return { use: 'bundled', reason: 'no-staged' };
  if (compareVersions(stagedVersion, bundledVersion) <= 0) {
    return { use: 'bundled', reason: 'not-newer' };
  }
  if (state.quarantined && state.quarantined.version === stagedVersion) {
    return { use: 'bundled', reason: 'blocked' };
  }
  // Just quarantined and relaunched — bundled for this launch, no matter what.
  if (recovering) return { use: 'bundled', reason: 'recovering' };

  const trials = state.version === stagedVersion ? (state.trials ?? 0) : 0;
  if (trials >= maxTrials) return { use: 'bundled', reason: 'too-many-trials' };
  return { use: 'staged', trials: trials + 1 };
}

/* ----------------------------------------------------------- filesystem ---- */

export function createPayloadStore(paths: Paths, fsImpl: Fs = nodeFs) {
  const fs = fsImpl;

  function readVersion(dir: string): string | null {
    try {
      const raw = fs.readFileSync(nodePath.join(dir, 'version.json'), 'utf8') as string;
      const v = (JSON.parse(raw) as { version?: unknown }).version;
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  }

  function isComplete(dir: string): boolean {
    return REQUIRED_FILES.every((f) => fs.existsSync(nodePath.join(dir, f)));
  }

  /** Best-effort recursive delete. True when the directory is really gone. */
  function removeDir(dir: string): boolean {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* partial delete: the caller checks the result */
    }
    return !fs.existsSync(dir);
  }

  function readState(): BootState {
    try {
      const s = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8') as string) as unknown;
      return s && typeof s === 'object' ? (s as BootState) : {};
    } catch {
      return {};
    }
  }

  function writeState(state: BootState): void {
    try {
      fs.writeFileSync(paths.stateFile, JSON.stringify(state), 'utf8');
    } catch {
      /* best effort — the marker in the directory still guards correctness */
    }
  }

  /**
   * Install a verified <userData>/payload-new, while nothing is loaded from
   * either directory. Renames only, so a crash at any point leaves something
   * the next launch can pick up.
   */
  function promoteIncoming(): 'installed' | 'discarded' | 'none' | 'failed' {
    if (!fs.existsSync(paths.incomingDir)) return 'none';

    const incomingVersion = readVersion(paths.incomingDir);
    const complete = fs.existsSync(nodePath.join(paths.incomingDir, STAGED_MARKER)) &&
      !!incomingVersion && isComplete(paths.incomingDir);
    const current = readVersion(paths.stagedDir);

    if (!complete || (current && compareVersions(incomingVersion as string, current) <= 0)) {
      // Interrupted download, or nothing newer than what is already staged.
      removeDir(paths.incomingDir);
      return 'discarded';
    }

    let oldDir = paths.stagedDir + '-old';
    try {
      if (fs.existsSync(paths.stagedDir)) {
        // A leftover -old that will not delete gets a fresh name rather than a failed rename.
        if (!removeDir(oldDir)) oldDir = paths.stagedDir + '-old-' + Date.now();
        fs.renameSync(paths.stagedDir, oldDir);
      }
      try {
        fs.renameSync(paths.incomingDir, paths.stagedDir);
      } catch (err) {
        // Put the previous payload back so this launch still has it.
        if (fs.existsSync(oldDir) && !fs.existsSync(paths.stagedDir)) {
          fs.renameSync(oldDir, paths.stagedDir);
        }
        throw err;
      }
    } catch {
      return 'failed';
    }

    // The user re-downloaded a version we had thrown out — they get to retry it.
    const state = readState();
    if (state.quarantined && state.quarantined.version === incomingVersion) {
      delete state.quarantined;
      writeState(state);
    }
    return 'installed';
  }

  /** payload-old / payload-old-<n> from earlier launches; nothing loads from them. */
  function removeLeftovers(): void {
    const prefix = nodePath.basename(paths.stagedDir) + '-old';
    try {
      for (const name of fs.readdirSync(paths.userData) as unknown as string[]) {
        if (name === prefix || name.startsWith(prefix + '-')) {
          removeDir(nodePath.join(paths.userData, String(name)));
        }
      }
    } catch {
      /* userData missing on first run */
    }
  }

  function quarantine(version: string | null, reason: string, at: string): void {
    const dead = paths.stagedDir + '-broken';
    removeDir(dead);
    let removed = false;
    try {
      fs.renameSync(paths.stagedDir, dead);
      removed = true;
    } catch {
      removed = removeDir(paths.stagedDir);
    }
    // Drops the trial counter; the marker alone keeps this version out even if
    // the directory could not be removed.
    writeState({ quarantined: { version, reason, at, removed } });
  }

  /** The staged version on disk, or null when there is nothing usable. */
  function stagedVersion(): string | null {
    if (fs.existsSync(paths.stagedDir) && !isComplete(paths.stagedDir)) {
      // A corpse (partial delete, interrupted rename) is never a candidate.
      removeDir(paths.stagedDir);
    }
    return isComplete(paths.stagedDir) ? readVersion(paths.stagedDir) : null;
  }

  function quarantinedVersion(): string | null {
    const s = readState();
    return s.quarantined && typeof s.quarantined.version === 'string' ? s.quarantined.version : null;
  }

  return {
    readVersion,
    isComplete,
    removeDir,
    readState,
    writeState,
    promoteIncoming,
    removeLeftovers,
    quarantine,
    stagedVersion,
    quarantinedVersion,
  };
}

export type PayloadStore = ReturnType<typeof createPayloadStore>;
