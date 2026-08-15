#!/usr/bin/env node
/**
 * Compile TypeScript into the app directory the Electron runtime loads.
 *
 *   src/boot        -> app/boot.js            (never replaced by an update)
 *   src/main        -> app/payload/main.js
 *   src/preload     -> app/payload/preload.js
 *   src/renderer    -> app/payload/renderer/bundle.js
 *   static/*        -> app/…                  (html, css, icons, manifest)
 *
 * Everything is bundled, so the shipped app still has no node_modules and the
 * update payload is a handful of self-contained files.
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'app');
const payloadDir = path.join(appDir, 'payload');

const { version } = require(path.join(root, 'package.json'));
if (typeof version !== 'string' || !/^\d+(\.\d+)*$/.test(version)) {
  throw new Error(`package.json version "${version}" is not a release version`);
}

fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(path.join(payloadDir, 'renderer'), { recursive: true });

const common = {
  bundle: true,
  minify: false,          // shipped source stays readable; the payload is tiny anyway
  sourcemap: false,
  logLevel: 'warning',
  target: ['node20', 'chrome120'],
};

await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(root, 'src/boot/index.ts')],
    outfile: path.join(appDir, 'boot.js'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(payloadDir, 'main.js'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(payloadDir, 'preload.js'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: [path.join(root, 'src/renderer/index.ts')],
    outfile: path.join(payloadDir, 'renderer', 'bundle.js'),
    platform: 'browser',
    format: 'iife',
  }),
  // The packer is TypeScript too, so the tested code is the code that runs.
  build({
    ...common,
    entryPoints: [path.join(root, 'tools/make-payload.ts')],
    outfile: path.join(root, 'dist/tools/make-payload.cjs'),
    platform: 'node',
    format: 'cjs',
  }),
]);

/* -------------------------------------------------------------- static ---- */

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

copyDir(path.join(root, 'static/assets'), path.join(payloadDir, 'assets'));
fs.copyFileSync(
  path.join(root, 'static/renderer/index.html'),
  path.join(payloadDir, 'renderer', 'index.html'),
);
fs.copyFileSync(
  path.join(root, 'static/renderer/style.css'),
  path.join(payloadDir, 'renderer', 'style.css'),
);

// package.json version is the single source of truth; both manifests follow it.
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'static/package.json'), 'utf8'));
manifest.version = version;
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(
  path.join(payloadDir, 'version.json'),
  JSON.stringify({ version }, null, 2) + '\n',
);

console.log(`==> built app/ for v${version}`);
