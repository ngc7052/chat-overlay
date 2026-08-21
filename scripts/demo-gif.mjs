/**
 * Turn the frames one `--media --only=<platform>` run left in docs/media into
 * that platform's README demo, and delete the frames.
 *
 *   node scripts/demo-gif.mjs youtube
 *
 * This used to be an ffmpeg incantation somebody had to remember, which is why
 * the three demos did not quite match each other. The numbers below are the
 * ones the first two were built with, recovered from the files themselves:
 *
 * - 40 frames captured 500ms apart, replayed at 5fps — 20 seconds of chat in an
 *   8 second loop. Slower reads as a still image on a README; faster is a blur.
 * - `scale=520` because 560 is the window and a little smaller sits better in a
 *   two-up table. The height follows from it.
 * - `max_colors=64` is the whole file size. At 256 the same frames come out at
 *   2.3MB and look no better: chat is flat text on a flat background, and the
 *   only gradients in it are the emote artwork, which is small. A README that
 *   costs 7MB to open is a worse README.
 * - `diff_mode=rectangle` so a frame stores the strip that scrolled rather than
 *   the whole window, and `stats_mode=diff` so the palette is chosen for the
 *   pixels that actually change instead of for the static background.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const media = path.join(root, 'docs', 'media');

const platform = process.argv[2];
if (!platform) {
  console.error('usage: node scripts/demo-gif.mjs <twitch|youtube|goodgame>');
  process.exit(2);
}

const frames = readdirSync(media).filter((f) => f.startsWith(`${platform}-frame-`) && f.endsWith('.png'));
if (!frames.length) {
  console.error(`no ${platform}-frame-*.png in docs/media — run the capture first:`);
  console.error(`  node test/e2e/run.mjs --media --only=${platform}`);
  process.exit(1);
}

const out = path.join(media, `demo-${platform}.gif`);
const ffmpeg = spawnSync('ffmpeg', [
  '-v', 'error', '-y',
  '-framerate', '5',
  '-i', path.join(media, `${platform}-frame-%03d.png`),
  '-filter_complex',
  'scale=520:-1:flags=lanczos,split[a][b];'
  + '[a]palettegen=max_colors=64:stats_mode=diff[p];'
  + '[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
  '-loop', '0',
  out,
], { stdio: 'inherit' });

if (ffmpeg.error?.code === 'ENOENT') {
  console.error('ffmpeg is not on PATH — it is only needed to re-capture the README demos.');
  process.exit(1);
}
if (ffmpeg.status !== 0) process.exit(ffmpeg.status ?? 1);

// The frames are left where they are. docs/media is an allowlist in
// .gitignore, so they cannot be committed by accident, and nothing here is
// worth a script that deletes files on its own.
console.log(`==> docs/media/demo-${platform}.gif from ${frames.length} frames`);
console.log(`    (${frames.length} ${platform}-frame-*.png left in docs/media; git ignores them)`);
