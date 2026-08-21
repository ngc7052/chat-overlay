import { describe, expect, it } from 'vitest';
import { changelogSection, demoUrl, preamble, releaseNotes } from '../../tools/release-notes.js';

/*
 * These exist because the inline version of this shipped broken in every
 * release it ever ran, and nothing said so: the notes simply came out without
 * the changelog, which looks like a choice rather than a fault. The first test
 * below is the one that would have caught it.
 */

const CHANGELOG = `# chat-overlay

## 1.4.0

### Minor Changes

- 2e7a63e: Moderators and channel owners now get the same badge on every platform.

### Patch Changes

- fd73f4c: A YouTube channel can be added without the \`@\`.

## 1.3.0

### Minor Changes

- 945b985: The top bar now says nothing while every channel is connected.

## 1.0.0

The first one, written by hand.
`;

describe('changelogSection', () => {
  it('finds the section for a version, without its heading', () => {
    const section = changelogSection(CHANGELOG, '1.4.0');
    expect(section).toContain('Moderators and channel owners');
    expect(section).toContain('A YouTube channel can be added');
    expect(section).not.toContain('## 1.4.0');
  });

  it('stops at the next version rather than swallowing the rest of the file', () => {
    const section = changelogSection(CHANGELOG, '1.4.0');
    expect(section).not.toContain('The top bar now says nothing');
    expect(section).not.toContain('written by hand');
  });

  it('reads the last section, which has no version after it to stop at', () => {
    expect(changelogSection(CHANGELOG, '1.0.0')).toBe('The first one, written by hand.');
  });

  it('reads a section in the middle', () => {
    expect(changelogSection(CHANGELOG, '1.3.0')).toContain('The top bar now says nothing');
  });

  it('returns nothing for a version that has no section', () => {
    expect(changelogSection(CHANGELOG, '9.9.9')).toBe('');
  });

  it('does not treat the dots in a version as wildcards', () => {
    // Unescaped, `1.4.0` matches `1x4y0` — which is how a release ends up
    // publishing somebody else's notes.
    expect(changelogSection('## 1x4y0\n\nwrong section\n', '1.4.0')).toBe('');
  });

  it('does not match a version that merely starts with this one', () => {
    const log = '## 1.4.0-rc.1\n\nthe candidate\n\n## 1.4.0\n\nthe real one\n';
    expect(changelogSection(log, '1.4.0')).toBe('the real one');
  });

  it('tolerates trailing whitespace on the heading', () => {
    expect(changelogSection('## 1.4.0  \n\nkept\n', '1.4.0')).toBe('kept');
  });

  it('ignores a heading that is not at the start of a line', () => {
    expect(changelogSection('text ## 1.4.0\n\nnot a heading\n', '1.4.0')).toBe('');
  });
});

describe('releaseNotes', () => {
  const input = { version: '1.4.0', tag: 'v1.4.0', repo: 'ngc7052/chat-overlay', changelog: CHANGELOG };

  it('leads with how to run it', () => {
    expect(releaseNotes(input)).toContain('unzip anywhere, run `ChatOverlay.exe`');
  });

  it('warns about SmartScreen, which every first-time user meets', () => {
    expect(releaseNotes(input)).toContain('More info → Run anyway');
  });

  it('shows the overlay, pinned to this tag so the picture never drifts', () => {
    expect(releaseNotes(input)).toContain(
      '![ChatOverlay](https://raw.githubusercontent.com/ngc7052/chat-overlay/v1.4.0/docs/media/demo-twitch.gif)',
    );
  });

  it('carries this version\'s changelog under a heading of its own', () => {
    const notes = releaseNotes(input);
    expect(notes).toContain('## Changes');
    expect(notes).toContain('Moderators and channel owners');
  });

  it('omits the Changes heading entirely when there is no section to put under it', () => {
    const notes = releaseNotes({ ...input, version: '9.9.9' });
    expect(notes).not.toContain('## Changes');
    // The rest still stands on its own — a release with no entry is publishable.
    expect(notes).toContain('unzip anywhere');
  });

  it('ends with a newline, because it is written to a file', () => {
    expect(releaseNotes(input).endsWith('\n')).toBe(true);
  });
});

describe('demoUrl and preamble', () => {
  it('pins the demo to a tag', () => {
    expect(demoUrl('a/b', 'v2.0.0')).toBe(
      'https://raw.githubusercontent.com/a/b/v2.0.0/docs/media/demo-twitch.gif',
    );
  });

  it('names the update route for people who already have it installed', () => {
    expect(preamble()).toContain('Settings → **Updates**');
  });
});
