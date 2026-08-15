'use strict';

/*
 * Bootstrapper. This file never changes — it is the one part of the app that an
 * update cannot touch, which is what makes updating safe.
 *
 * The real app lives in a "payload" directory. Two can exist:
 *
 *   <resources>/app/payload   the version that shipped inside the zip
 *   <userData>/payload        a newer one downloaded by the updater
 *
 * The newer of the two wins. The updater never writes into either: it drops a
 * fully verified copy into <userData>/payload-new, and this file moves it into
 * place on the next launch — before anything is loaded from it, so no file the
 * running process holds open is ever replaced. Every step of that move is a
 * rename, and a launch that finds a half-finished move completes or discards it.
 *
 * Crash safety: each launch of a staged payload is counted before it runs, and
 * the count is cleared only when the payload reports in (markHealthy — the
 * renderer is up and running). A payload that throws while loading, or crashes
 * before it reports in, is quarantined on the spot and the app relaunches on
 * the bundled version. One that merely never comes up is quarantined after
 * MAX_TRIALS launches. A quarantined version is remembered, so it is neither
 * selected nor offered again unless the user re-downloads it on purpose.
 *
 * Contract with the payload (global.__overlayPayload):
 *   dir, version, bundledDir, bundledVersion, stagedDir, incomingDir, usingStaged
 *   markHealthy()          call once the renderer is up; clears the trial count
 *   quarantinedVersion()   version string the updater must not offer, or null
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const MAX_TRIALS = 3;
const RECOVERY_FLAG = '--overlay-recovered';
const STAGED_MARKER = '.staged';   // written last by the updater; proves payload-new is complete
const REQUIRED_FILES = ['main.js', 'preload.js', 'version.json', 'renderer/index.html'];

const userData = app.getPath('userData');
const bundledDir = path.join(__dirname, 'payload');
const stagedDir = path.join(userData, 'payload');
const incomingDir = stagedDir + '-new';
const stateFile = path.join(userData, 'payload-state.json');

/* -------------------------------------------------------------- helpers */

function readVersion(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'version.json'), 'utf8');
    const v = JSON.parse(raw).version;
    return typeof v === 'string' ? v : null;
  } catch (err) {
    return null;
  }
}

/** Compare dotted numeric versions. Returns >0 when a is newer than b. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function isComplete(dir) {
  return REQUIRED_FILES.every((f) => fs.existsSync(path.join(dir, f)));
}

/** Best-effort recursive delete. Returns true when the directory is really gone. */
function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    /* partial delete: caller checks the result */
  }
  return !fs.existsSync(dir);
}

/*
 * State file: { version, trials, quarantined: { version, reason, at, removed } }
 *   version/trials  launch counter for the staged payload currently on disk
 *   quarantined     the last version that was thrown out, kept until a newer
 *                   one is staged so it is never selected or offered again
 */
function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch (err) {
    return {};
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
  } catch (err) {
    /* best effort */
  }
}

/* ---------------------------------------------------- finishing an update */

/**
 * <userData>/payload-new was written and verified by a previous run. Move it
 * into place now, while nothing is loaded from either directory. Renames only,
 * so a crash at any point leaves something the next launch can pick up:
 *   payload-old + payload-new       -> promote again
 *   payload (new) + payload-old      -> just clean up
 */
function promoteIncoming() {
  if (!fs.existsSync(incomingDir)) return;

  const incomingVersion = readVersion(incomingDir);
  const complete = fs.existsSync(path.join(incomingDir, STAGED_MARKER)) &&
    incomingVersion && isComplete(incomingDir);
  const current = readVersion(stagedDir);
  if (!complete || (current && compareVersions(incomingVersion, current) <= 0)) {
    // Interrupted download, or nothing newer than what is already staged.
    removeDir(incomingDir);
    return;
  }

  let oldDir = stagedDir + '-old';
  try {
    if (fs.existsSync(stagedDir)) {
      // A leftover -old that will not delete gets a fresh name rather than a failed rename.
      if (!removeDir(oldDir)) oldDir = stagedDir + '-old-' + Date.now();
      fs.renameSync(stagedDir, oldDir);
    }
    try {
      fs.renameSync(incomingDir, stagedDir);
    } catch (err) {
      // Put the previous payload back so this launch still has it.
      if (fs.existsSync(oldDir) && !fs.existsSync(stagedDir)) fs.renameSync(oldDir, stagedDir);
      throw err;
    }
  } catch (err) {
    console.error('could not install staged update, keeping current payload:', err.message);
    return;
  }

  // The user re-downloaded a version we had thrown out — they get to retry it.
  const state = readState();
  if (state.quarantined && state.quarantined.version === incomingVersion) {
    delete state.quarantined;
    writeState(state);
  }
}

/* ------------------------------------------------------------ selection */

let stagedVersion = null;
let dir = bundledDir;
let version = null;
let usingStaged = false;

function quarantine(reason) {
  const dead = stagedDir + '-broken';
  removeDir(dead);
  let removed = false;
  try {
    fs.renameSync(stagedDir, dead);
    removed = true;
  } catch (err) {
    removed = removeDir(stagedDir);
  }
  // Drops the trial counter; the marker alone keeps this version out even if
  // the directory could not be removed.
  writeState({
    quarantined: { version: stagedVersion, reason, at: new Date().toISOString(), removed },
  });
  usingStaged = false;
  console.error(`payload v${stagedVersion} quarantined: ${reason}`);
}

/** Start over on the bundled payload; the flag stops a second recovery in a row. */
function relaunchRecovered() {
  const args = process.argv.slice(1).filter((a) => a !== RECOVERY_FLAG);
  app.relaunch({ args: args.concat(RECOVERY_FLAG) });
  app.exit(1);
}

/** payload-old / payload-old-<n> from earlier launches: nothing loads from them. */
function removeLeftovers() {
  const prefix = path.basename(stagedDir) + '-old';
  try {
    for (const name of fs.readdirSync(userData)) {
      if (name === prefix || name.startsWith(prefix + '-')) removeDir(path.join(userData, name));
    }
  } catch (err) {
    /* userData missing on first run */
  }
}

promoteIncoming();
removeLeftovers();

const recovering = process.argv.includes(RECOVERY_FLAG);
const bundledVersion = readVersion(bundledDir) || '0.0.0';
version = bundledVersion;

if (fs.existsSync(stagedDir) && !isComplete(stagedDir)) {
  // A corpse (partial delete, interrupted rename) is never a candidate.
  removeDir(stagedDir);
}
stagedVersion = isComplete(stagedDir) ? readVersion(stagedDir) : null;

if (stagedVersion && compareVersions(stagedVersion, bundledVersion) > 0) {
  const state = readState();
  const blocked = state.quarantined && state.quarantined.version === stagedVersion;
  const trials = state.version === stagedVersion ? (state.trials || 0) : 0;

  if (blocked) {
    // Already thrown out; the directory only survives if removal failed last time.
    removeDir(stagedDir);
  } else if (recovering) {
    // Just quarantined and relaunched — bundled for this launch, no matter what.
  } else if (trials >= MAX_TRIALS) {
    quarantine(`failed to start ${trials} times`);
  } else {
    writeState({ ...state, version: stagedVersion, trials: trials + 1 });
    dir = stagedDir;
    version = stagedVersion;
    usingStaged = true;
  }
}

/* -------------------------------------------------------- health / crash */

let healthy = false;

function onStartupCrash(err) {
  const text = err && err.stack ? err.stack : String(err);
  console.error(text);
  if (!usingStaged || healthy) return;
  quarantine('crashed before the renderer came up: ' + text.split('\n')[0]);
  relaunchRecovered();
}

/** The payload calls this once its renderer is up: that is what "works" means. */
function markHealthy() {
  if (healthy) return;
  healthy = true;
  process.removeListener('uncaughtException', onStartupCrash);
  process.removeListener('unhandledRejection', onStartupCrash);
  if (usingStaged) writeState({ version, trials: 0 });
}

if (usingStaged) {
  // Until the payload reports in, any crash counts against it. Electron only
  // logs unhandled rejections, and a throw inside app.whenReady().then() is
  // one of those, so both are needed. Removed again by markHealthy().
  process.on('uncaughtException', onStartupCrash);
  process.on('unhandledRejection', onStartupCrash);
}

// Handed to the real main process so it can report versions and stage updates.
global.__overlayPayload = {
  dir,
  version,
  bundledDir,
  bundledVersion,
  stagedDir,
  incomingDir,
  usingStaged,
  markHealthy,
  quarantinedVersion: () => {
    const s = readState();
    return s.quarantined && typeof s.quarantined.version === 'string' ? s.quarantined.version : null;
  },
};

try {
  require(path.join(dir, 'main.js'));
} catch (err) {
  if (!usingStaged) throw err;
  console.error(err);
  quarantine('threw while loading: ' + err.message);
  // The broken payload already ran some of its top-level code (IPC handlers,
  // event listeners…) in this process, so the bundled one cannot simply be
  // required on top of it. Start clean instead.
  relaunchRecovered();
}
