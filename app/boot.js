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
 * The newer of the two wins. Because the running code is never the code being
 * overwritten, an update never has to replace a file Windows has open.
 *
 * Crash safety: each attempt at a staged payload is counted before it runs and
 * cleared once the app reaches "ready". A payload that fails to boot three
 * times is quarantined and the bundled one takes over, so a bad release can
 * never brick the install.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const MAX_TRIALS = 3;

const bundledDir = path.join(__dirname, 'payload');
const stagedDir = path.join(app.getPath('userData'), 'payload');
const stateFile = path.join(app.getPath('userData'), 'payload-state.json');

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

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {};
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

function quarantine(reason) {
  try {
    const dead = stagedDir + '-broken';
    fs.rmSync(dead, { recursive: true, force: true });
    fs.renameSync(stagedDir, dead);
  } catch (err) {
    try { fs.rmSync(stagedDir, { recursive: true, force: true }); } catch (e) { /* give up */ }
  }
  writeState({});
  console.error('payload quarantined:', reason);
}

const bundledVersion = readVersion(bundledDir) || '0.0.0';
const stagedVersion = fs.existsSync(path.join(stagedDir, 'main.js')) ? readVersion(stagedDir) : null;

let dir = bundledDir;
let version = bundledVersion;
let usingStaged = false;

if (stagedVersion && compareVersions(stagedVersion, bundledVersion) > 0) {
  const state = readState();
  const trials = state.version === stagedVersion ? (state.trials || 0) : 0;
  if (trials >= MAX_TRIALS) {
    quarantine(`v${stagedVersion} failed to start ${trials} times`);
  } else {
    writeState({ version: stagedVersion, trials: trials + 1 });
    dir = stagedDir;
    version = stagedVersion;
    usingStaged = true;
  }
}

// Handed to the real main process so it can report versions and stage updates.
global.__overlayPayload = {
  dir,
  version,
  bundledDir,
  bundledVersion,
  stagedDir,
  usingStaged,
};

// Surviving to "ready" is our definition of a working payload.
app.whenReady().then(() => {
  if (usingStaged) writeState({ version, trials: 0 });
});

try {
  require(path.join(dir, 'main.js'));
} catch (err) {
  if (usingStaged) {
    quarantine('threw while loading: ' + err.message);
    global.__overlayPayload = {
      dir: bundledDir,
      version: bundledVersion,
      bundledDir,
      bundledVersion,
      stagedDir,
      usingStaged: false,
    };
    require(path.join(bundledDir, 'main.js'));
  } else {
    throw err;
  }
}
