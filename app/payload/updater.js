'use strict';

/*
 * Update checking and staging.
 *
 * Electron's built-in autoUpdater needs a Squirrel/NSIS installer and a signed
 * binary, and cannot update a portable unpacked app at all. It is also aimed at
 * replacing the whole 137 MB runtime. Here the Electron runtime is fixed and
 * only the app payload changes, so an update is a ~35 KB gzipped manifest:
 *
 *   { version, files: { "<relative path>": { sha256, enc, data } } }
 *
 * It is written to <userData>/payload and picked up by boot.js on next launch,
 * so nothing ever overwrites a file the running process holds open.
 */

const { app, net } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

const RELEASE_API = process.env.OVERLAY_UPDATE_API ||
  'https://api.github.com/repos/ngc7052/chat-overlay/releases/latest';
const ASSET_NAME = 'app-payload.json.gz';
const UA = 'ChatOverlay';

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

function currentVersion() {
  const p = global.__overlayPayload;
  return (p && p.version) || app.getVersion();
}

async function fetchJson(url) {
  const res = await net.fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/**
 * Ask GitHub what the latest release is.
 * Returns { version, newer, url, page, notes }.
 */
async function check() {
  const rel = await fetchJson(RELEASE_API);
  const version = String(rel.tag_name || '').replace(/^v/i, '').trim();
  if (!/^\d+(\.\d+)*$/.test(version)) throw new Error('unexpected tag: ' + rel.tag_name);

  const asset = (rel.assets || []).find((a) => a.name === ASSET_NAME);
  const current = currentVersion();

  return {
    version,
    current,
    newer: compareVersions(version, current) > 0,
    url: asset ? asset.browser_download_url : null,
    page: rel.html_url || null,
    notes: typeof rel.body === 'string' ? rel.body.slice(0, 4000) : '',
  };
}

/** Reject anything that could escape the payload directory. */
function safeRelativePath(rel) {
  if (typeof rel !== 'string' || !rel) return null;
  if (rel.includes('\\') || rel.includes('\0')) return null;
  if (path.posix.isAbsolute(rel)) return null;
  const normalised = path.posix.normalize(rel);
  if (normalised.startsWith('../') || normalised === '..') return null;
  return normalised;
}

function decode(entry) {
  if (entry.enc === 'base64') return Buffer.from(entry.data, 'base64');
  return Buffer.from(String(entry.data), 'utf8');
}

/**
 * Download the manifest and write it to <userData>/payload.
 * Every file is hash-checked after it lands on disk; a failure anywhere leaves
 * the existing payload untouched.
 */
async function download(url, expectedVersion) {
  const res = await net.fetch(url, {
    headers: { Accept: 'application/octet-stream', 'User-Agent': UA },
  });
  if (!res.ok) throw new Error('download failed: HTTP ' + res.status);

  const gz = Buffer.from(await res.arrayBuffer());
  let manifest;
  try {
    manifest = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  } catch (err) {
    throw new Error('corrupt update package: ' + err.message);
  }

  if (!manifest || typeof manifest !== 'object' || !manifest.files) {
    throw new Error('update package has no files');
  }
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error(`package is v${manifest.version}, release says v${expectedVersion}`);
  }
  for (const required of ['main.js', 'preload.js', 'version.json', 'renderer/index.html']) {
    if (!manifest.files[required]) throw new Error('update package is missing ' + required);
  }

  const stagedDir = global.__overlayPayload.stagedDir;
  const tmpDir = stagedDir + '-new';
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  let count = 0;
  for (const [rel, entry] of Object.entries(manifest.files)) {
    const safe = safeRelativePath(rel);
    if (!safe) throw new Error('refusing suspicious path in update: ' + rel);

    const dest = path.join(tmpDir, safe);
    if (!dest.startsWith(tmpDir + path.sep)) throw new Error('path escape: ' + rel);

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buf = decode(entry);
    fs.writeFileSync(dest, buf);

    if (entry.sha256) {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
      if (actual !== entry.sha256) throw new Error('checksum mismatch for ' + rel);
    }
    count += 1;
  }

  // Swap in only once everything verified.
  fs.rmSync(stagedDir, { recursive: true, force: true });
  fs.renameSync(tmpDir, stagedDir);

  // New version gets a fresh set of boot attempts.
  try {
    fs.writeFileSync(
      path.join(app.getPath('userData'), 'payload-state.json'),
      JSON.stringify({ version: manifest.version, trials: 0 }),
      'utf8'
    );
  } catch (err) {
    /* boot.js copes without it */
  }

  return { version: manifest.version, files: count };
}

function restart() {
  app.relaunch();
  app.exit(0);
}

module.exports = { check, download, restart, compareVersions, currentVersion };
