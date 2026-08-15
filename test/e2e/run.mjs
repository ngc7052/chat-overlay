/**
 * End-to-end: boots the real, unmodified app against the fake chat server and
 * asserts on what is actually painted.
 *
 *   node test/e2e/run.mjs                     assert only
 *   node test/e2e/run.mjs --media             also write docs/media/*.png
 *   node test/e2e/run.mjs --scenario=drop     kill the sockets, expect recovery
 *   node test/e2e/run.mjs --scenario=degraded break every catalogue endpoint
 *
 * The unit suite covers the rules; this covers the wiring the unit suite
 * deliberately does not — that a message arriving on a socket ends up on screen
 * with its badges, emotes and colours, that locking hides the chrome, and that
 * the settings panel opens and closes.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  loop: wantMedia || scenario === 'drop',
  only,
  // Mid-transcript, so there is traffic before and after the break.
  dropAfterMs: scenario === 'drop' ? 4000 : 0,
  failCatalogues: scenario === 'degraded',
});
const dataDir = path.join(root, 'dist', 'e2e-profile');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const allSources = [
  { platform: 'twitch', channel: 'halcyon_tv', enabled: true },
  { platform: 'goodgame', channel: 'vetroduy', enabled: true },
];

writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  sources: only ? allSources.filter((s) => s.platform === only) : allSources,
  locked: false,
  bounds: { x: 60, y: 60, width: 560, height: 520 },
  bgOpacity: 0,
  hoverBgOpacity: 0.55,
  fontSize: 15,
  maxMessages: 40,
  autoCheckUpdates: false,     // no network in a test run
}, null, 2));

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

if (code !== 0) {
  console.error(`\ne2e FAILED (exit ${code})`);
  process.exit(code || 1);
}
if (!out.includes('E2E PASS')) {
  console.error('\ne2e FAILED: driver did not report a pass');
  process.exit(1);
}
console.log('\ne2e OK');
