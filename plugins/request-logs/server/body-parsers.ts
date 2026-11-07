import { finished } from 'node:stream/promises';
import { Parser } from 'stream-json';
import type { RequestLogBodyStreamParser } from '@jeffusion/bungee-core/plugin';

export const json: RequestLogBodyStreamParser = {
  async *stream(body) {
    const parser = new Parser({ packValues: false, streamValues: true });
    const done = finished(parser);
    void done.catch(() => {});
    let depth = 0;
    parser.on('data', ({ name }: { name: string }) => {
      if (name === 'startArray' || name === 'startObject') {
        if (++depth > 1024) parser.destroy(new Error('JSON nesting limit exceeded'));
      } else if (name === 'endArray' || name === 'endObject') depth--;
    });
    // The tokenizer accepts Unicode whitespace. Only JSON whitespace is valid between values.
    let inString = false;
    let escaped = false;
    try {
      for await (const part of body.textChunks()) {
        let escapedIndex: number = escaped ? 0 : -1;
        for (const match of part.matchAll(/["\\\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\uffff]/g)) {
          if (match.index === escapedIndex) continue;
          if (inString && match[0] === '\\') escapedIndex = match.index + 1;
          else if (match[0] === '"') inString = !inString;
          else if (!inString) throw new Error('Invalid character outside JSON string');
        }
        escaped = escapedIndex === part.length;
        if (!part) continue;
        await new Promise<void>((resolve, reject) => parser.write(part, error => error ? reject(error) : resolve()));
        yield part;
      }
      parser.end();
      await done;
    } finally { parser.destroy(); }
  },
};

export const text: RequestLogBodyStreamParser = {
  format: 'text',
  async *stream(body) {
    yield* body.textChunks();
  },
};
