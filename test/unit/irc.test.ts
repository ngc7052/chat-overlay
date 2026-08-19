import { describe, expect, it } from 'vitest';
import { nickFromPrefix, parseIrc, unescapeTag } from '../../src/renderer/sources/irc.js';

describe('unescapeTag', () => {
  it('decodes the IRCv3 escapes', () => {
    expect(unescapeTag('a\\sb')).toBe('a b');
    expect(unescapeTag('a\\:b')).toBe('a;b');
    expect(unescapeTag('a\\nb')).toBe('a\nb');
    expect(unescapeTag('a\\rb')).toBe('a\rb');
    expect(unescapeTag('a\\\\b')).toBe('a\\b');
  });

  it('leaves ordinary text alone', () => {
    expect(unescapeTag('plain')).toBe('plain');
  });

  // One pass, not one replace per escape: unescaping \\ to \ and then looking
  // for \s again eats the s that followed a literal backslash.
  it('reads each escape once, so a literal backslash keeps the letter after it', () => {
    expect(unescapeTag('\\\\s')).toBe('\\s');
    expect(unescapeTag('\\\\')).toBe('\\');
    expect(unescapeTag('a\\\\s\\sb')).toBe('a\\s b');
  });

  it('drops the backslash from an escape it does not know', () => {
    expect(unescapeTag('a\\qb')).toBe('aqb');
    expect(unescapeTag('trailing\\')).toBe('trailing');
  });
});

describe('parseIrc', () => {
  it('parses a tagged PRIVMSG', () => {
    const line = '@badge-info=subscriber/27;badges=subscriber/24;color=#FF0000;display-name=K_u_p;' +
      'id=abc;tmi-sent-ts=1786661981379 :k_u_p!k_u_p@k_u_p.tmi.twitch.tv PRIVMSG #xqc :hello world';
    const m = parseIrc(line);
    expect(m.command).toBe('PRIVMSG');
    expect(m.tags['display-name']).toBe('K_u_p');
    expect(m.tags['color']).toBe('#FF0000');
    expect(m.prefix).toBe('k_u_p!k_u_p@k_u_p.tmi.twitch.tv');
    expect(m.params).toEqual(['#xqc', 'hello world']);
  });

  it('keeps a colon inside the message body', () => {
    const m = parseIrc(':a!a@a PRIVMSG #c :look: a colon');
    expect(m.params[m.params.length - 1]).toBe('look: a colon');
  });

  it('handles a message with no tags', () => {
    const m = parseIrc(':tmi.twitch.tv 001 justinfan1 :Welcome, GLHF!');
    expect(m.command).toBe('001');
    expect(m.tags).toEqual({});
    expect(m.params).toEqual(['justinfan1', 'Welcome, GLHF!']);
  });

  it('handles a bare command with no prefix or trailing', () => {
    const m = parseIrc('PING');
    expect(m).toEqual({ tags: {}, prefix: '', command: 'PING', params: [] });
  });

  it('handles PING with a trailing token', () => {
    const m = parseIrc('PING :tmi.twitch.tv');
    expect(m.command).toBe('PING');
    expect(m.params).toEqual(['tmi.twitch.tv']);
  });

  it('reads a valueless tag as an empty string', () => {
    const m = parseIrc('@mod;subscriber=1 :a!a@a PRIVMSG #c :hi');
    expect(m.tags['mod']).toBe('');
    expect(m.tags['subscriber']).toBe('1');
  });

  it('unescapes tag values', () => {
    const m = parseIrc('@system-msg=Sub\\sfor\\s3\\smonths! :tmi.twitch.tv USERNOTICE #c');
    expect(m.tags['system-msg']).toBe('Sub for 3 months!');
  });

  it('survives a line that is only tags', () => {
    const m = parseIrc('@a=b');
    expect(m.tags['a']).toBe('b');
    expect(m.command).toBe('');
  });

  it('survives a line that is only a prefix', () => {
    const m = parseIrc(':tmi.twitch.tv');
    expect(m.prefix).toBe('tmi.twitch.tv');
    expect(m.command).toBe('');
  });

  it('ignores an empty tag segment', () => {
    const m = parseIrc('@a=b; :x!x@x PRIVMSG #c :hi');
    expect(m.tags).toEqual({ a: 'b' });
  });

  it('returns an empty command for an empty line', () => {
    expect(parseIrc('').command).toBe('');
  });
});

describe('nickFromPrefix', () => {
  it('takes the nick and lowercases it', () => {
    expect(nickFromPrefix('K_u_P!k@k.tmi.twitch.tv')).toBe('k_u_p');
  });

  it('copes with a server prefix that has no nick separator', () => {
    expect(nickFromPrefix('tmi.twitch.tv')).toBe('tmi.twitch.tv');
  });

  it('returns empty for an empty prefix', () => {
    expect(nickFromPrefix('')).toBe('');
  });
});
