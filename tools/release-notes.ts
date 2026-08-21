/*
 * The body of a GitHub release.
 *
 * This used to be a `node -e "..."` inside the release workflow, and it was
 * silently broken for every release it ever ran: the script sat inside shell
 * double quotes, which ate one level of backslash, so `\\s` reached node as
 * `\s` inside a string literal and then as a bare `s` in the pattern. The
 * regex became `^## 1.4.0s*$(sS*?)...`, matched nothing, and the step fell
 * back to publishing without the changelog. Nobody noticed, because the
 * fallback is a perfectly reasonable-looking page.
 *
 * So it lives here instead: a pure function with tests, called with argv. No
 * shell quoting layer, and a lie about which section belongs to a version now
 * fails a test rather than a release nobody re-reads.
 */

/** Where the demo lives, pinned to the tag so old notes keep their own picture. */
export function demoUrl(repo: string, tag: string): string {
  return `https://raw.githubusercontent.com/${repo}/${tag}/docs/media/demo-twitch.gif`;
}

/**
 * The section of CHANGELOG.md belonging to one version, without its heading.
 *
 * Anchored on `## <version>` at the start of a line and stopping at the next
 * `## `, which is how `changeset version` writes the file. The version is
 * escaped: unescaped, `1.4.0` would also match `1x4y0`, and — the one that
 * would really bite — `1.1.0` is a prefix of `1.1.0-rc`, so the boundary is
 * checked too. Returns '' when the version has no section, which is not an
 * error: a release can legitimately be published before its entry exists.
 */
export function changelogSection(log: string, version: string): string {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^## ${escaped}[ \\t]*$([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm');
  const found = pattern.exec(log);
  return found ? (found[1] ?? '').trim() : '';
}

/** What every release says regardless of what changed in it. */
export function preamble(): string {
  return [
    'Download **`ChatOverlay.zip`** below, unzip anywhere, run `ChatOverlay.exe`.',
    'Windows 10/11 64-bit — no installer, no Node.js, no admin rights.',
    '',
    'Windows shows a SmartScreen warning the first time because the exe is not',
    'code-signed: **More info → Run anyway**.',
    '',
    'Existing installs pick this up from Settings → **Updates** (about 50 KB).',
  ].join('\n');
}

export interface NotesInput {
  version: string;
  tag: string;
  changelog: string;
  repo: string;
}

/**
 * The whole body: what it is and how to run it, a picture of it running, then
 * this version's changelog.
 *
 * The picture is here because the release page is where the README's download
 * link lands, and a page of prose is a poor advertisement for something whose
 * entire point is how it looks on screen.
 */
export function releaseNotes({ version, tag, changelog, repo }: NotesInput): string {
  const parts = [preamble(), '', `![ChatOverlay](${demoUrl(repo, tag)})`, '', '---'];
  const section = changelogSection(changelog, version);
  if (section) parts.push('', '## Changes', '', section);
  return parts.join('\n') + '\n';
}

/* c8 ignore start -- CLI entry, exercised through the release workflow */
const invokedDirectly = process.argv[1] && /release-notes\.(ts|js|mjs|cjs)$/.test(process.argv[1]);
if (invokedDirectly) {
  const [version, tag, repo, changelogPath, out] = process.argv.slice(2);
  if (!version || !tag || !repo || !changelogPath || !out) {
    console.error('usage: release-notes <version> <tag> <owner/repo> <CHANGELOG.md> <out.md>');
    process.exit(1);
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  const changelog = fs.readFileSync(changelogPath, 'utf8');
  const body = releaseNotes({ version, tag, repo, changelog });
  fs.writeFileSync(out, body);
  const section = changelogSection(changelog, version);
  // A release whose notes lost their changelog is the exact failure this file
  // exists to stop, so it says which it wrote rather than leaving it to be
  // discovered on the published page.
  console.log(section
    ? `    ${out}  ${version} notes, ${section.split('\n').length} changelog lines`
    : `    ${out}  ${version} notes, NO CHANGELOG SECTION FOUND`);
}
/* c8 ignore stop */
