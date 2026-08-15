import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The end-to-end build widens the Content-Security-Policy to loopback so it can
 * talk to the fake chat server. That must never reach a shipped build, so the
 * policy in the source file is asserted here rather than trusted.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(path.join(root, 'static/renderer/index.html'), 'utf8');

function directive(name: string): string {
  const csp = /content="([^"]*default-src[^"]*)"/s.exec(html)?.[1] ?? '';
  const match = new RegExp(`${name}\\s+([^;]*)`).exec(csp);
  return (match?.[1] ?? '').replace(/\s+/g, ' ').trim();
}

describe('shipped Content-Security-Policy', () => {
  it('only allows the two real chat origins to be connected to', () => {
    expect(directive('connect-src')).toBe(
      'wss://chat.goodgame.ru wss://irc-ws.chat.twitch.tv',
    );
  });

  it('never allows loopback, which is the e2e-only exception', () => {
    const csp = html.slice(html.indexOf('Content-Security-Policy'));
    expect(csp).not.toMatch(/127\.0\.0\.1/);
    expect(csp).not.toMatch(/localhost/);
  });

  it('allows no scripts beyond the bundle it ships', () => {
    expect(directive('script-src')).toBe("'self'");
  });

  it('allows no inline styles, so user CSS has to go through CSSOM', () => {
    expect(directive('style-src')).toBe("'self'");
  });

  it('blocks everything not explicitly allowed', () => {
    expect(directive('default-src')).toBe("'none'");
  });

  it('loads scripts only from the bundle, never a CDN', () => {
    const scripts = Array.from(html.matchAll(/<script[^>]*src="([^"]+)"/g)).map((m) => m[1]);
    expect(scripts).toEqual(['bundle.js']);
  });
});
