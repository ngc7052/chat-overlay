/**
 * End-to-end: boots the real, unmodified app against the fake chat server and
 * asserts on what is actually painted.
 *
 *   node test/e2e/run.mjs                     assert only
 *   node test/e2e/run.mjs --media             also write docs/media/*.png
 *   node test/e2e/run.mjs --scenario=drop     kill the sockets, expect recovery
 *   node test/e2e/run.mjs --scenario=stall    hold them open and go silent
 *   node test/e2e/run.mjs --scenario=degraded break every catalogue endpoint
 *   node test/e2e/run.mjs --scenario=yt-offline a youtube channel that is not live yet
 *   node test/e2e/run.mjs --scenario=yt-ended   a youtube stream that ends mid-chat
 *   node test/e2e/run.mjs --scenario=staged   a downloaded payload must be run
 *   node test/e2e/run.mjs --scenario=trials   one that never starts is dropped
 *   node test/e2e/run.mjs --scenario=crash    one that throws is quarantined
 *
 * The unit suite covers the rules; this covers the wiring the unit suite
 * deliberately does not — that a message arriving on a socket ends up on screen
 * with its badges, emotes and colours, that locking hides the chrome, and that
 * the settings panel opens and closes.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeChat } from './fake-chat-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const wantMedia = process.argv.includes('--media');
// --only=twitch / --only=goodgame captures one chat at a time, so a demo shows
// what a single platform looks like rather than two interleaved.
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || null;
// Scenarios put the app under conditions a real chat produces daily but a
// happy-path run never sees: a dropped connection, and a catalogue host that
// is down. Each runs the same real app against the same fake server.
const scenario = (process.argv.find((a) => a.startsWith('--scenario=')) ?? '').split('=')[1] || '';

// Build the e2e variant first, so the run always matches the current sources.
await new Promise((resolve, reject) => {
  const build = spawn(process.execPath, [path.join(root, 'scripts', 'build.mjs')], {
    cwd: root,
    env: { ...process.env, OVERLAY_E2E: '1' },
    stdio: 'inherit',
  });
  build.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('build failed'))));
});

const server = await startFakeChat({
  loop: wantMedia || scenario === 'drop' || scenario === 'stall',
  only,
  // Mid-transcript, so there is traffic before and after the break.
  dropAfterMs: scenario === 'drop' ? 4000 : 0,
  stallAfterMs: scenario === 'stall' ? 4000 : 0,
  failCatalogues: scenario === 'degraded',
  // A YouTube channel is not an address but a stream, so "offline" and "over"
  // are ordinary states rather than failures — and neither has an analogue in
  // either socket protocol.
  ytLiveAfterMs: scenario === 'yt-offline' ? 6000 : 0,
  ytEndAfterMs: scenario === 'yt-ended' ? 4000 : 0,
});
// Outside the repo on purpose. A real install keeps its payload under
// %APPDATA%, where no package.json sits above it; inside the repo, node finds
// the root's "type": "module" and refuses to load a staged payload as
// CommonJS — an artefact of the harness that a real install never sees.
const dataDir = path.join(os.tmpdir(), 'chat-overlay-e2e-profile');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const allSources = [
  { platform: 'twitch', channel: 'halcyon_tv', enabled: true },
  { platform: 'goodgame', channel: 'vetroduy', enabled: true },
  { platform: 'youtube', channel: '@northlight', enabled: true },
];

/**
 * drop and stall are about what a *socket* does when it dies without saying so,
 * and about the bar's "every channel is down" wording. A polling source that
 * carries on regardless would not strengthen either — it would only mean two of
 * three channels are down instead of all of them, and quietly retire the one
 * assertion that tells the two messages apart. YouTube gets its own scenarios.
 */
const socketScenario = scenario === 'drop' || scenario === 'stall';
const sources = only
  ? allSources.filter((s) => s.platform === only)
  : allSources.filter((s) => !socketScenario || s.platform !== 'youtube');

writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  sources,
  locked: false,
  bounds: { x: 60, y: 60, width: 560, height: 520 },
  bgOpacity: 0,
  hoverBgOpacity: 0.55,
  fontSize: 15,
  maxMessages: 60,     // above the 43 lines the three transcripts add up to, so nothing is trimmed mid-run
  autoCheckUpdates: false,     // no network in a test run
}, null, 2));

/**
 * Put a downloaded payload where boot will find it.
 *
 * The app that shipped is copied and renamed to a version far ahead of it, so
 * boot has a real reason to prefer it — and, for the crash case, a main.js that
 * throws the moment it is loaded.
 */
const STAGED_VERSION = '99.0.0';
function stagePayload({ broken = false } = {}) {
  const incoming = path.join(dataDir, 'payload-new');
  cpSync(path.join(root, 'app', 'payload'), incoming, { recursive: true });
  writeFileSync(path.join(incoming, 'version.json'), JSON.stringify({ version: STAGED_VERSION }));
  if (broken) writeFileSync(path.join(incoming, 'main.js'), 'throw new Error("payload is broken");\n');
  // Written last by the updater, and the only thing that marks it complete.
  writeFileSync(path.join(incoming, '.staged'), JSON.stringify({ version: STAGED_VERSION }));
}

if (scenario === 'staged') stagePayload();
if (scenario === 'crash') stagePayload({ broken: true });
if (scenario === 'trials') {
  stagePayload();
  // Three launches already counted and never cleared: whatever is in there
  // does not start, and boot has to stop choosing it.
  writeFileSync(
    path.join(dataDir, 'payload-state.json'),
    JSON.stringify({ version: STAGED_VERSION, trials: 3 }),
  );
}

const driver = path.join(here, 'driver.cjs');
const electron = path.join(root, 'node_modules', 'electron', 'cli.js');

const child = spawn(process.execPath, [electron, '--no-sandbox', driver], {
  cwd: root,
  env: {
    ...process.env,
    ...server.env,
    OVERLAY_E2E_PROFILE: dataDir,
    OVERLAY_E2E_MEDIA: wantMedia ? path.join(root, 'docs', 'media') : '',
    OVERLAY_E2E_PREFIX: only ? only + '-' : '',
    OVERLAY_E2E_ONLY: only ?? '',
    OVERLAY_E2E_SCENARIO: scenario,
    // Four minutes of patience is right for a real install and impossible for a
    // test run, so the stall scenario shrinks the watchdog to a couple of
    // seconds. Every other run leaves it empty and gets the shipped numbers.
    OVERLAY_TEST_WATCHDOG_MS: scenario === 'stall' ? '2500'
      // For YouTube this is also how long a channel that is not live waits
      // before asking again — two minutes in a real install, which is right
      // when the page that answers is over a megabyte, and impossible here.
      : (scenario === 'yt-offline' || scenario === 'yt-ended') ? '2000' : '',
    // Same idea for the pause the bar takes before reporting a connection as
    // down: seconds of deliberate patience in a real install, a moment here.
    OVERLAY_TEST_ALERT_MS: scenario === 'drop' || scenario === 'stall' ? '400' : '',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
child.stderr.on('data', (d) => {
  const text = String(d);
  // Electron on a headless box is noisy about dbus and GPU; neither is ours.
  if (!/dbus|DBus|GPU|gpu|Gtk|libva|Vulkan|sandbox/i.test(text)) process.stderr.write(text);
});

const code = await new Promise((resolve) => child.on('exit', resolve));
await server.close();

if (scenario === 'crash') {
  // boot quarantines the payload and relaunches on the bundled one, so this
  // process is meant to end non-zero. What matters is what it left on disk.
  const state = JSON.parse(readFileSync(path.join(dataDir, 'payload-state.json'), 'utf8'));
  const problems = [];
  if (code === 0) problems.push('expected a recovery exit, got 0');
  if (state.quarantined?.version !== STAGED_VERSION) {
    problems.push(`state does not quarantine ${STAGED_VERSION}: ${JSON.stringify(state)}`);
  }
  if (!/threw while loading/.test(state.quarantined?.reason ?? '')) {
    problems.push(`quarantine reason is not the load failure: ${state.quarantined?.reason}`);
  }
  if (existsSync(path.join(dataDir, 'payload'))) problems.push('the broken payload is still installed');
  if (!existsSync(path.join(dataDir, 'payload-broken'))) problems.push('nothing was moved aside');
  for (const p of problems) console.error('  FAIL ' + p);
  if (problems.length) {
    console.error(`\ne2e FAILED: ${problems.length} check(s) failed`);
    process.exit(1);
  }
  console.log('  ok  a payload that throws is quarantined, and the app relaunches without it');
  console.log('\ne2e OK');
  process.exit(0);
}

if (code !== 0) {
  console.error(`\ne2e FAILED (exit ${code})`);
  process.exit(code || 1);
}
if (!out.includes('E2E PASS')) {
  console.error('\ne2e FAILED: driver did not report a pass');
  process.exit(1);
}
console.log('\ne2e OK');
