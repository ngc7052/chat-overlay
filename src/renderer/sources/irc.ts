/** Minimal IRCv3 parsing — enough for Twitch's tagged PRIVMSG stream. */

export interface IrcMessage {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string[];
}

/** IRCv3 tag values escape the characters that would break the wire format. */
export function unescapeTag(v: string): string {
  return String(v)
    .replace(/\\s/g, ' ')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\:/g, ';')
    .replace(/\\\\/g, '\\');
}

export function parseIrc(line: string): IrcMessage {
  let rest = line;
  const tags: Record<string, string> = {};

  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    const tagText = sp === -1 ? rest.slice(1) : rest.slice(1, sp);
    for (const kv of tagText.split(';')) {
      if (!kv) continue;
      const eq = kv.indexOf('=');
      if (eq === -1) tags[kv] = '';
      else tags[kv.slice(0, eq)] = unescapeTag(kv.slice(eq + 1));
    }
    rest = sp === -1 ? '' : rest.slice(sp + 1);
  }

  let prefix = '';
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = sp === -1 ? rest.slice(1) : rest.slice(1, sp);
    rest = sp === -1 ? '' : rest.slice(sp + 1);
  }

  // The trailing parameter starts at the first " :" and runs to end of line.
  let trailing: string | null = null;
  const ti = rest.indexOf(' :');
  if (ti !== -1) {
    trailing = rest.slice(ti + 2);
    rest = rest.slice(0, ti);
  }

  const bits = rest.split(' ').filter(Boolean);
  const command = bits.shift() ?? '';
  const params = bits;
  if (trailing !== null) params.push(trailing);

  return { tags, prefix, command, params };
}

/** `nick!user@host` -> `nick` */
export function nickFromPrefix(prefix: string): string {
  const nick = prefix.split('!')[0];
  return nick ? nick.toLowerCase() : '';
}
