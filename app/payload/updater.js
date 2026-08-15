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
 * It is written to <userData>/payload-new — never into the payload that is
 * running — and boot.js moves it into place on the next launch, so nothing
 * ever overwrites a file the running process holds open.
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
const CHECK_TIMEOUT_MS = 20 * 1000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const STAGED_MARKER = '.staged';   // must match boot.js
const REQUIRED_FILES = ['main.js', 'preload.js', 'version.json', 'renderer/index.html'];

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

/** What boot.js told us, with fallbacks for running the payload directly. */
function payloadInfo() {
  const p = global.__overlayPayload || {};
  const stagedDir = p.stagedDir || path.join(app.getPath('userData'), 'payload');
  return {
    version: p.version || app.getVersion(),
    stagedDir,
    incomingDir: p.incomingDir || stagedDir + '-new',
    quarantinedVersion: typeof p.quarantinedVersion === 'function' ? p.quarantinedVersion() : null,
  };
}

function currentVersion() {
  return payloadInfo().version;
}

async function fetchWithTimeout(url, headers, timeoutMs) {
  try {
    return await net.fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  }
}

async function fetchJson(url) {
  const res = await fetchWithTimeout(url, { Accept: 'application/vnd.github+json', 'User-Agent': UA }, CHECK_TIMEOUT_MS);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/**
 * Ask GitHub what the latest release is.
 * Returns { version, current, newer, quarantined, url, page, notes }.
 * `quarantined` is set when that version was already tried here and thrown out
 * by boot.js — callers should not offer it unprompted.
 */
async function check() {
  const rel = await fetchJson(RELEASE_API);
  const version = String(rel.tag_name || '').replace(/^v/i, '').trim();
  if (!/^\d+(\.\d+)*$/.test(version)) throw new Error('unexpected tag: ' + rel.tag_name);

  const asset = (rel.assets || []).find((a) => a.name === ASSET_NAME);
  const info = payloadInfo();

  return {
    version,
    current: info.version,
    newer: compareVersions(version, info.version) > 0,
    quarantined: version === info.quarantinedVersion,
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
  if (path.posix.basename(normalised) === STAGED_MARKER) return null;   // ours, written last
  return normalised;
}

function decode(rel, entry) {
  if (!entry || typeof entry !== 'object') throw new Error('bad entry for ' + rel);
  if (typeof entry.data !== 'string') throw new Error('no data for ' + rel);
  if (!/^[0-9a-f]{64}$/i.test(String(entry.sha256 || ''))) throw new Error('no checksum for ' + rel);
  if (entry.enc === 'base64') return Buffer.from(entry.data, 'base64');
  if (entry.enc === 'utf8' || entry.enc == null) return Buffer.from(entry.data, 'utf8');
  throw new Error(`unknown encoding "${entry.enc}" for ${rel}`);
}

/**
 * Download the manifest and write it to <userData>/payload-new.
 * Every file is hash-checked after it lands on disk, and the marker that lets
 * boot.js install the directory is written only once all of them verify. The
 * running payload is never touched; the swap happens on the next launch.
 */
async function download(url, expectedVersion) {
  const res = await fetchWithTimeout(url, { Accept: 'application/octet-stream', 'User-Agent': UA }, DOWNLOAD_TIMEOUT_MS);
  if (!res.ok) throw new Error('download failed: HTTP ' + res.status);

  const gz = Buffer.from(await res.arrayBuffer());
  let manifest;
  try {
    manifest = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  } catch (err) {
    throw new Error('corrupt update package: ' + err.message);
  }

  if (!manifest || typeof manifest !== 'object' || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('update package has no files');
  }
  if (typeof manifest.version !== 'string' || !/^\d+(\.\d+)*$/.test(manifest.version)) {
    throw new Error('update package has no version');
  }
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error(`package is v${manifest.version}, release says v${expectedVersion}`);
  }
  for (const required of REQUIRED_FILES) {
    if (!manifest.files[required]) throw new Error('update package is missing ' + required);
  }

  const { incomingDir } = payloadInfo();
  fs.rmSync(incomingDir, { recursive: true, force: true });
  fs.mkdirSync(incomingDir, { recursive: true });

  let count = 0;
  for (const [rel, entry] of Object.entries(manifest.files)) {
    const safe = safeRelativePath(rel);
    if (!safe) throw new Error('refusing suspicious path in update: ' + rel);

    const dest = path.join(incomingDir, safe);
    if (!dest.startsWith(incomingDir + path.sep)) throw new Error('path escape: ' + rel);

    const buf = decode(rel, entry);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);

    const actual = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    if (actual !== String(entry.sha256).toLowerCase()) throw new Error('checksum mismatch for ' + rel);
    count += 1;
  }

  // Marker last: boot.js only installs a payload-new that carries it.
  fs.writeFileSync(
    path.join(incomingDir, STAGED_MARKER),
    JSON.stringify({ version: manifest.version, files: count, at: new Date().toISOString() }),
    'utf8'
  );

  return { version: manifest.version, files: count };
}

/** Restart through app.quit() so will-quit still saves config and drops hotkeys. */
function restart() {
  app.relaunch();
  app.quit();
}

module.exports = { check, download, restart, compareVersions, currentVersion };
