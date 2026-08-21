import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Badge } from '../../src/renderer/sources/types.js';
import { badgeIconPath } from '../../src/renderer/view.js';

/**
 * The bundled role artwork, checked as files rather than as a name in a map.
 *
 * The paths are taken from `badgeIconPath` itself, so a rename that the app
 * still compiles against but that no longer points at a file fails here instead
 * of shipping as a badge that is silently missing.
 *
 * The fill assertions are the important ones. GoodGame's chat icons are plain
 * white SVGs, and an earlier version of this app drew them as CSS masks — which
 * discards the artwork entirely and paints the element's colour through the
 * alpha channel, so every badge came out the same silhouette. These are drawn
 * as <img>, which needs the artwork to carry its own colours; a file that
 * relies on `currentColor`, or that is one flat shape, would look right in a
 * mask and wrong here.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const badge = (kind: string): Badge => ({ kind, label: kind, url: null, title: kind });

function artwork(kind: string): string {
  const rel = badgeIconPath(badge(kind));
  expect(rel).toBeTruthy();
  // The renderer resolves it against static/renderer/, where index.html lives.
  return readFileSync(path.resolve(root, 'static/renderer', rel as string), 'utf8');
}

describe('bundled role badge artwork', () => {
  for (const kind of ['moderator', 'broadcaster']) {
    describe(kind, () => {
      const svg = artwork(kind);

      it('carries its own colours, so an <img> shows the symbol', () => {
        const fills = new Set(Array.from(svg.matchAll(/fill="(#[0-9a-f]{3,8})"/gi), (m) => m[1]));
        expect(fills.size).toBeGreaterThanOrEqual(2);
        expect(svg).not.toMatch(/currentColor/);
      });

      it('needs nothing fetched to draw', () => {
        expect(svg).not.toMatch(/<image\b/);
        expect(svg).not.toMatch(/\bhref=/);
        expect(svg).not.toMatch(/url\(/);
      });

      it('is square, so it sits on the line like every other badge', () => {
        expect(svg).toMatch(/viewBox="0 0 18 18"/);
      });
    });
  }

  it('draws the two roles as two different pictures', () => {
    expect(artwork('moderator')).not.toBe(artwork('broadcaster'));
  });
});
