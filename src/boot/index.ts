import { app } from 'electron';
import * as path from 'node:path';
import type { PayloadHandoff } from '../main/types.js';
import { choosePayload, createPayloadStore, MAX_TRIALS, pathsFor } from './payload.js';

/*
 * Bootstrapper. This file never changes — it is the one part of the app that an
 * update cannot touch, which is what makes updating safe.
 *
 * The real app lives in a "payload" directory. Two can exist:
 *
 *   <resources>/app/payload   the version that shipped inside the zip
 *   <userData>/payload        a newer one downloaded by the updater
 *
 * The updater never writes into either: it drops a fully verified copy into
 * <userData>/payload-new, and this file moves it into place on the next launch,
 * before anything is loaded from it.
 *
 * Crash safety: each launch of a staged payload is counted before it runs, and
 * the count is cleared only when the payload reports in (markHealthy). One that
 * throws while loading, or crashes before reporting in, is quarantined on the
 * spot and the app relaunches on the bundled version.
 */

const RECOVERY_FLAG = '--overlay-recovered';

const paths = pathsFor(app.getPath('userData'), __dirname);
const store = createPayloadStore(paths);

store.promoteIncoming();
store.removeLeftovers();

const recovering = process.argv.includes(RECOVERY_FLAG);
const bundledVersion = store.readVersion(paths.bundledDir) ?? '0.0.0';
const stagedVersion = store.stagedVersion();

const choice = choosePayload({
  bundledVersion,
  stagedVersion,
  state: store.readState(),
  recovering,
});

let dir = paths.bundledDir;
let version = bundledVersion;
let usingStaged = false;

if (choice.use === 'staged') {
  store.writeState({ ...store.readState(), version: stagedVersion as string, trials: choice.trials });
  dir = paths.stagedDir;
  version = stagedVersion as string;
  usingStaged = true;
} else if (choice.reason === 'too-many-trials') {
  quarantine(`failed to start ${MAX_TRIALS} times`);
} else if (choice.reason === 'blocked') {
  // Already thrown out; the directory only survives if removal failed last time.
  store.removeDir(paths.stagedDir);
}

function quarantine(reason: string): void {
  store.quarantine(stagedVersion, reason, new Date().toISOString());
  usingStaged = false;
  console.error(`payload v${stagedVersion} quarantined: ${reason}`);
}

/** Start over on the bundled payload; the flag stops a second recovery in a row. */
function relaunchRecovered(): void {
  const args = process.argv.slice(1).filter((a) => a !== RECOVERY_FLAG);
  app.relaunch({ args: args.concat(RECOVERY_FLAG) });
  app.exit(1);
}

let healthy = false;

function onStartupCrash(err: unknown): void {
  const text = err instanceof Error && err.stack ? err.stack : String(err);
  console.error(text);
  if (!usingStaged || healthy) return;
  quarantine('crashed before the renderer came up: ' + text.split('\n')[0]);
  relaunchRecovered();
}

/** The payload calls this once its renderer is up: that is what "works" means. */
function markHealthy(): void {
  if (healthy) return;
  healthy = true;
  process.removeListener('uncaughtException', onStartupCrash);
  process.removeListener('unhandledRejection', onStartupCrash);
  if (usingStaged) store.writeState({ version, trials: 0 });
}

if (usingStaged) {
  // Until the payload reports in, any crash counts against it. Electron only
  // logs unhandled rejections, and a throw inside app.whenReady().then() is one
  // of those, so both are needed. Removed again by markHealthy().
  process.on('uncaughtException', onStartupCrash);
  process.on('unhandledRejection', onStartupCrash);
}

const handoff: PayloadHandoff = {
  dir,
  version,
  bundledDir: paths.bundledDir,
  bundledVersion,
  stagedDir: paths.stagedDir,
  incomingDir: paths.incomingDir,
  usingStaged,
  markHealthy,
  quarantinedVersion: () => store.quarantinedVersion(),
};
(globalThis as { __overlayPayload?: PayloadHandoff }).__overlayPayload = handoff;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(path.join(dir, 'main.js'));
} catch (err) {
  if (!usingStaged) throw err;
  console.error(err);
  quarantine('threw while loading: ' + (err as Error).message);
  // The broken payload already ran some of its top-level code (IPC handlers,
  // event listeners…) in this process, so the bundled one cannot simply be
  // required on top of it. Start clean instead.
  relaunchRecovered();
}
