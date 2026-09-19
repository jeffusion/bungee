/** Small bounded JSON reader that rejects duplicate keys at every object level. */
export function parseStrictJson(text: string, maxDepth = 64): unknown {
  let index = 0;
  const whitespace = () => { while (/\s/.test(text[index] ?? '')) index += 1; };
  const fail = (): never => { throw new SyntaxError('invalid JSON'); };
  const string = (): string => {
    if (text[index] !== '"') return fail();
    const start = index++;
    while (index < text.length) {
      const character = text[index++];
      if (character === '"') return JSON.parse(text.slice(start, index)) as string;
      if (character === '\\') {
        const escape = text[index++];
        if (escape === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index, index + 4))) return fail(); index += 4; }
        else if (escape !== '"' && escape !== '\\' && escape !== '/' && escape !== 'b' && escape !== 'f' && escape !== 'n' && escape !== 'r' && escape !== 't') return fail();
      } else if (character < ' ') return fail();
    }
    return fail();
  };
  const value = (depth: number): void => {
    if (depth > maxDepth) return fail();
    whitespace();
    if (text[index] === '{') {
      index += 1; whitespace(); const keys = new Set<string>();
      if (text[index] === '}') { index += 1; return; }
      while (true) {
        whitespace(); const key = string(); if (keys.has(key)) return fail(); keys.add(key); whitespace();
        if (text[index++] !== ':') return fail(); value(depth + 1); whitespace();
        if (text[index] === '}') { index += 1; return; }
        if (text[index++] !== ',') return fail();
      }
    }
    if (text[index] === '[') {
      index += 1; whitespace(); if (text[index] === ']') { index += 1; return; }
      while (true) { value(depth + 1); whitespace(); if (text[index] === ']') { index += 1; return; } if (text[index++] !== ',') return fail(); }
    }
    if (text[index] === '"') { string(); return; }
    if (text.startsWith('true', index)) { index += 4; return; }
    if (text.startsWith('false', index)) { index += 5; return; }
    if (text.startsWith('null', index)) { index += 4; return; }
    const number = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number === null) return fail(); index += number[0].length;
  };
  value(0); whitespace(); if (index !== text.length) return fail();
  return JSON.parse(text) as unknown;
}
