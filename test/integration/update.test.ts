import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { choosePayload, createPayloadStore, MAX_TRIALS, pathsFor, STAGED_MARKER } from '../../src/boot/payload.js';
import { createUpdater } from '../../src/main/updater/index.js';
import { buildPayload, serialisePayload, type Payload } from '../../tools/make-payload.js';

/**
 * The update path, end to end, against a real filesystem and a real HTTP
 * server: pack a payload with the same tool the release uses, serve it the way
 * GitHub does, download it through the real updater, and hand the result to the
 * real boot-time store.
 *
 * The unit tests around these modules all inject a fake `fs`, which means they
 * prove the rules and not the outcome. This is the only subsystem that rewrites
 * the app on disk, and a bad one bricks every install, so it is worth watching
 * the bytes actually land.
 */

let tmp: string;
let server: Server;
let origin: string;

/** What the server hands out; rewritten per test. */
let releaseBody: unknown = null;
let packageBody: Buffer | null = null;
let releaseStatus = 200;
let packageStatus = 200;

function writePayloadDir(dir: string, version: string, extra: Record<string, string> = {}): void {
  const files: Record<string, string> = {
    'main.js': `console.log(${JSON.stringify('payload ' + version)});\n`,
    'preload.js': 'module.exports = {};\n',
    'version.json': JSON.stringify({ version }) + '\n',
    'renderer/index.html': `<!doctype html><title>v${version}</title>\n`,
    ...extra,
  };
  for (const [rel, body] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }
}

/** A release exactly as the client expects to find it. */
function release(version: string, withAsset = true) {
  return {
    tag_name: 'v' + version,
    html_url: `${origin}/releases/v${version}`,
    assets: withAsset
      ? [{ name: 'app-payload.json.gz', browser_download_url: `${origin}/app-payload.json.gz` }]
      : [],
  };
}

function updaterFor(
  userData: string,
  currentVersion: string,
  quarantined: string | null = null,
  writes?: string[],
) {
  const paths = pathsFor(userData, path.join(tmp, 'resources', 'app'));
  // Real fs, but recording the order of writes when a test asks for it. mtimes
  // cannot answer "was the marker written last" — several files land in the
  // same millisecond — and that ordering is the whole crash-safety guarantee.
  const recording = writes
    ? {
        ...fs,
        writeFileSync: ((file: string, data: never, opts: never) => {
          writes.push(path.relative(paths.incomingDir, String(file)));
          return fs.writeFileSync(file, data, opts);
        }) as typeof fs.writeFileSync,
      }
    : undefined;
  return createUpdater({
    fetch: fetch as never,
    releaseApi: `${origin}/releases/latest`,
    incomingDir: () => paths.incomingDir,
    currentVersion: () => currentVersion,
    quarantinedVersion: () => quarantined,
    ...(recording ? { fs: recording } : {}),
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/releases/latest')) {
      res.writeHead(releaseStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(releaseBody));
      return;
    }
    if (req.url?.startsWith('/app-payload.json.gz')) {
      if (packageStatus !== 200 || !packageBody) {
        res.writeHead(packageStatus).end('nope');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(packageBody);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  origin = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-update-'));
  releaseStatus = 200;
  packageStatus = 200;
  releaseBody = null;
  packageBody = null;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Pack a version with the real tool, and serve it. */
function publish(version: string, mutate?: (p: Payload) => void): Payload {
  const src = path.join(tmp, 'build', version);
  writePayloadDir(src, version);
  const payload = buildPayload(src);
  mutate?.(payload);
  packageBody = serialisePayload(payload);
  releaseBody = release(version);
  return payload;
}

describe('downloading a real release', () => {
  it('stages every file, byte for byte, with the marker written last', async () => {
    const userData = path.join(tmp, 'userData');
    fs.mkdirSync(userData, { recursive: true });
    const payload = publish('1.2.0');

    const writes: string[] = [];
    const updater = updaterFor(userData, '1.1.0', null, writes);
    const info = await updater.check();
    expect(info).toMatchObject({ newer: true, version: '1.2.0' });

    const staged = await updater.download(info.url as string, info.version);
    expect(staged).toEqual({ version: '1.2.0', files: Object.keys(payload.files).length });

    // Every file is on disk with the bytes the manifest promised.
    const incoming = pathsFor(userData, '').incomingDir;
    for (const [rel, entry] of Object.entries(payload.files)) {
      const onDisk = fs.readFileSync(path.join(incoming, rel));
      expect(createHash('sha256').update(onDisk).digest('hex')).toBe(entry.sha256);
    }

    // The marker proves the directory is complete, so it must be the very last
    // write: a payload interrupted before it is discarded wholesale.
    const marker = JSON.parse(fs.readFileSync(path.join(incoming, STAGED_MARKER), 'utf8'));
    expect(marker).toMatchObject({ version: '1.2.0' });
    expect(writes.at(-1)).toBe(STAGED_MARKER);
    expect(writes.filter((w) => w === STAGED_MARKER)).toHaveLength(1);
    expect(writes.slice(0, -1).sort()).toEqual(Object.keys(payload.files).sort());
  });

  it('never touches the payload that is running', async () => {
    const userData = path.join(tmp, 'userData');
    const bundled = path.join(tmp, 'resources', 'app', 'payload');
    writePayloadDir(bundled, '1.1.0');
    const before = fs.readFileSync(path.join(bundled, 'main.js'), 'utf8');

    publish('1.2.0');
    const updater = updaterFor(userData, '1.1.0');
    const info = await updater.check();
    await updater.download(info.url as string, info.version);

    // This is what stops Windows file locking from breaking an update.
    expect(fs.readFileSync(path.join(bundled, 'main.js'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(userData, 'payload'))).toBe(false);
  });
});

describe('a package that cannot be trusted', () => {
  async function attempt(mutate?: (p: Payload) => void, body?: Buffer): Promise<string> {
    const userData = path.join(tmp, 'userData');
    publish('1.2.0', mutate);
    if (body) packageBody = body;
    const updater = updaterFor(userData, '1.1.0');
    const info = await updater.check();
    try {
      await updater.download(info.url as string, info.version);
      return 'no error';
    } catch (err) {
      return (err as Error).message;
    }
  }

  const markerOf = (): boolean => {
    const incoming = pathsFor(path.join(tmp, 'userData'), '').incomingDir;
    return fs.existsSync(path.join(incoming, STAGED_MARKER));
  };

  it('rejects a file whose contents do not match its checksum', async () => {
    const msg = await attempt((p) => {
      (p.files['main.js'] as { data: string }).data = 'console.log("tampered");\n';
    });
    expect(msg).toContain('checksum mismatch for main.js');
    expect(markerOf()).toBe(false);
  });

  it('rejects a truncated download rather than writing half an app', async () => {
    // Pack it properly first, then serve only the front half — what a dropped
    // connection leaves the client holding.
    const src = path.join(tmp, 'build', 'truncated');
    writePayloadDir(src, '1.2.0');
    const good = serialisePayload(buildPayload(src));
    const msg = await attempt(undefined, good.subarray(0, Math.floor(good.length / 2)));
    expect(msg).toContain('corrupt update package');
    expect(markerOf()).toBe(false);
  });

  it('rejects a package that is not gzip at all', async () => {
    const msg = await attempt(undefined, Buffer.from('<html>404 from a proxy</html>'));
    expect(msg).toContain('corrupt update package');
  });

  it('rejects a package missing a file the app needs to boot', async () => {
    const msg = await attempt((p) => { delete p.files['preload.js']; });
    expect(msg).toContain('missing preload.js');
    expect(markerOf()).toBe(false);
  });

  it('rejects a package whose version disagrees with the release tag', async () => {
    const msg = await attempt((p) => { p.version = '9.9.9'; });
    expect(msg).toContain('package is v9.9.9, release says v1.2.0');
  });

  it('refuses a path that would escape the payload directory', async () => {
    const msg = await attempt((p) => {
      p.files['../../evil.js'] = { sha256: 'a'.repeat(64), enc: 'utf8', data: 'pwned' };
    });
    expect(msg).toContain('refusing suspicious path');
    expect(fs.existsSync(path.join(tmp, 'evil.js'))).toBe(false);
  });

  it('reports a release the server will not serve', async () => {
    releaseStatus = 500;
    releaseBody = {};
    const updater = updaterFor(path.join(tmp, 'userData'), '1.1.0');
    await expect(updater.check()).rejects.toThrow('HTTP 500');
  });

  it('reports an asset that 404s', async () => {
    publish('1.2.0');
    packageStatus = 404;
    const updater = updaterFor(path.join(tmp, 'userData'), '1.1.0');
    const info = await updater.check();
    await expect(updater.download(info.url as string, info.version))
      .rejects.toThrow('download failed: HTTP 404');
  });

  it('treats a release with no payload asset as "download the full zip"', async () => {
    releaseBody = release('1.2.0', false);
    const updater = updaterFor(path.join(tmp, 'userData'), '1.1.0');
    const info = await updater.check();
    expect(info).toMatchObject({ newer: true, version: '1.2.0', url: null });
  });
});

describe('what boot does with a staged payload', () => {
  async function stage(version: string, current = '1.1.0'): Promise<{ userData: string; appDir: string }> {
    const userData = path.join(tmp, 'userData');
    const appDir = path.join(tmp, 'resources', 'app');
    writePayloadDir(path.join(appDir, 'payload'), current);
    fs.mkdirSync(userData, { recursive: true });
    publish(version);
    const updater = updaterFor(userData, current);
    const info = await updater.check();
    await updater.download(info.url as string, info.version);
    return { userData, appDir };
  }

  it('installs it on the next launch and runs it', async () => {
    const { userData, appDir } = await stage('1.2.0');
    const paths = pathsFor(userData, appDir);
    const store = createPayloadStore(paths);

    expect(store.stagedVersion()).toBe(null);        // not installed yet
    store.promoteIncoming();                          // what boot does first
    expect(store.stagedVersion()).toBe('1.2.0');
    expect(fs.existsSync(paths.incomingDir)).toBe(false);
    expect(fs.readFileSync(path.join(paths.stagedDir, 'main.js'), 'utf8')).toContain('payload 1.2.0');

    expect(choosePayload({
      bundledVersion: store.readVersion(paths.bundledDir) as string,
      stagedVersion: store.stagedVersion(),
      state: store.readState(),
      recovering: false,
    })).toEqual({ use: 'staged', trials: 1 });
  });

  it('discards an interrupted download: no marker, no install', async () => {
    const { userData, appDir } = await stage('1.2.0');
    const paths = pathsFor(userData, appDir);
    // Exactly what a download killed at the last moment leaves behind.
    fs.rmSync(path.join(paths.incomingDir, STAGED_MARKER));

    const store = createPayloadStore(paths);
    store.promoteIncoming();
    expect(store.stagedVersion()).toBe(null);
    expect(fs.existsSync(paths.stagedDir)).toBe(false);
  });

  it('quarantines a payload that keeps failing to start, and stays on the bundled one', async () => {
    const { userData, appDir } = await stage('1.2.0');
    const paths = pathsFor(userData, appDir);
    const store = createPayloadStore(paths);
    store.promoteIncoming();

    // Each launch counts a trial before running; a payload that dies never
    // clears it. After MAX_TRIALS the choice flips for good.
    let choice = choosePayload({
      bundledVersion: '1.1.0', stagedVersion: '1.2.0', state: store.readState(), recovering: false,
    });
    for (let launch = 0; launch < MAX_TRIALS; launch++) {
      expect(choice).toEqual({ use: 'staged', trials: launch + 1 });
      store.writeState({ version: '1.2.0', trials: (choice as { trials: number }).trials });
      choice = choosePayload({
        bundledVersion: '1.1.0', stagedVersion: '1.2.0', state: store.readState(), recovering: false,
      });
    }
    expect(choice).toEqual({ use: 'bundled', reason: 'too-many-trials' });

    // Quarantining deletes the payload as well as recording it, so the next
    // launch has nothing to choose from.
    store.quarantine('1.2.0', 'failed to start 3 times', new Date().toISOString());
    expect(store.quarantinedVersion()).toBe('1.2.0');
    expect(store.stagedVersion()).toBe(null);
    expect(fs.existsSync(pathsFor(userData, appDir).stagedDir)).toBe(false);
    expect(choosePayload({
      bundledVersion: '1.1.0', stagedVersion: store.stagedVersion(), state: store.readState(), recovering: false,
    })).toEqual({ use: 'bundled', reason: 'no-staged' });

    // And if the delete had failed — a file still open, say — the record alone
    // is enough to keep it from running.
    expect(choosePayload({
      bundledVersion: '1.1.0', stagedVersion: '1.2.0', state: store.readState(), recovering: false,
    })).toEqual({ use: 'bundled', reason: 'blocked' });
  });

  it('offers the quarantined version again only when asked, never as a nag', async () => {
    const { userData, appDir } = await stage('1.2.0');
    const store = createPayloadStore(pathsFor(userData, appDir));
    store.promoteIncoming();
    store.quarantine('1.2.0', 'crashed', new Date().toISOString());

    // check() is told what is quarantined; the same release must not be offered.
    const updater = updaterFor(userData, '1.1.0', store.quarantinedVersion());
    expect(await updater.check()).toMatchObject({ version: '1.2.0', quarantined: true });
  });

  it('ignores a staged payload that is not actually newer', async () => {
    const { userData, appDir } = await stage('1.2.0', '1.3.0');
    const store = createPayloadStore(pathsFor(userData, appDir));
    store.promoteIncoming();
    expect(choosePayload({
      bundledVersion: '1.3.0', stagedVersion: store.stagedVersion(), state: store.readState(), recovering: false,
    })).toEqual({ use: 'bundled', reason: 'not-newer' });
  });

  it('runs the bundled payload for one launch after a recovery', async () => {
    const { userData, appDir } = await stage('1.2.0');
    const store = createPayloadStore(pathsFor(userData, appDir));
    store.promoteIncoming();
    expect(choosePayload({
      bundledVersion: '1.1.0', stagedVersion: '1.2.0', state: store.readState(), recovering: true,
    })).toEqual({ use: 'bundled', reason: 'recovering' });
  });
});

describe('the packer and the client agree', () => {
  it('round-trips a binary file without corrupting it', async () => {
    const userData = path.join(tmp, 'userData');
    const src = path.join(tmp, 'build', 'bin');
    writePayloadDir(src, '1.2.0');
    // A PNG-ish blob with bytes that are not valid UTF-8.
    const blob = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80, 0x01]);
    fs.mkdirSync(path.join(src, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(src, 'assets', 'icon.png'), blob);

    const payload = buildPayload(src);
    expect(payload.files['assets/icon.png']?.enc).toBe('base64');
    packageBody = serialisePayload(payload);
    releaseBody = release('1.2.0');

    const updater = updaterFor(userData, '1.1.0');
    const info = await updater.check();
    await updater.download(info.url as string, info.version);

    const incoming = pathsFor(userData, '').incomingDir;
    expect(fs.readFileSync(path.join(incoming, 'assets', 'icon.png')).equals(blob)).toBe(true);
  });

  it('produces a package the client accepts, gzip and all', async () => {
    const src = path.join(tmp, 'build', 'plain');
    writePayloadDir(src, '2.0.0');
    const gz = serialisePayload(buildPayload(src));
    // Same shape the release asset has: gzip, JSON inside.
    expect(gz.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(gzipSync(Buffer.from('x')).subarray(0, 2)).toEqual(gz.subarray(0, 2));
  });
});
