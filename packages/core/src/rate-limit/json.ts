export type RateLimitJsonErrorCode = 'malformed_message' | 'message_too_large';

export class RateLimitJsonError extends Error {
  constructor(readonly code: RateLimitJsonErrorCode, options?: { cause?: unknown }) { super(code, options); }
}

class RateLimitJsonScanner {
  private offset = 0;
  private nodes = 0;

  constructor(private readonly content: string) {}

  scan(): void {
    this.value(0);
    this.whitespace();
    if (this.offset !== this.content.length) this.fail();
  }

  private fail(): never { throw new RateLimitJsonError('malformed_message'); }
  private whitespace(): void {
    while (this.offset < this.content.length && ' \t\r\n'.includes(this.content[this.offset]!)) this.offset += 1;
  }
  private take(expected: string): void {
    if (this.content[this.offset] !== expected) this.fail();
    this.offset += 1;
  }
  private value(depth: number): void {
    if (depth > 16 || ++this.nodes > 1_024) this.fail();
    this.whitespace();
    const token = this.content[this.offset];
    if (token === '{') this.object(depth);
    else if (token === '[') this.array(depth);
    else if (token === '"') this.string();
    else if (token === '-' || (token !== undefined && token >= '0' && token <= '9')) this.number();
    else if (this.content.startsWith('true', this.offset)) this.offset += 4;
    else if (this.content.startsWith('false', this.offset)) this.offset += 5;
    else if (this.content.startsWith('null', this.offset)) this.offset += 4;
    else this.fail();
  }
  private object(depth: number): void {
    this.take('{'); this.whitespace();
    const keys = new Set<string>();
    if (this.content[this.offset] === '}') { this.offset += 1; return; }
    while (true) {
      if (this.content[this.offset] !== '"') this.fail();
      const key = this.string();
      if (keys.has(key)) this.fail();
      keys.add(key);
      this.whitespace(); this.take(':'); this.value(depth + 1); this.whitespace();
      if (this.content[this.offset] === '}') { this.offset += 1; return; }
      this.take(','); this.whitespace();
    }
  }
  private array(depth: number): void {
    this.take('['); this.whitespace();
    if (this.content[this.offset] === ']') { this.offset += 1; return; }
    while (true) {
      this.value(depth + 1); this.whitespace();
      if (this.content[this.offset] === ']') { this.offset += 1; return; }
      this.take(','); this.whitespace();
    }
  }
  private string(): string {
    const start = this.offset;
    this.take('"');
    while (this.offset < this.content.length) {
      const character = this.content[this.offset];
      if (character === '"') {
        this.offset += 1;
        try {
          const value = JSON.parse(this.content.slice(start, this.offset));
          if (typeof value !== 'string') this.fail();
          return value;
        } catch (cause) {
          if (cause instanceof RateLimitJsonError) throw cause;
          this.fail();
        }
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) this.fail();
      if (character === '\\') {
        this.offset += 1;
        const escape = this.content[this.offset];
        if (escape === 'u') {
          const digits = this.content.slice(this.offset + 1, this.offset + 5);
          if (!/^[0-9A-Fa-f]{4}$/.test(digits)) this.fail();
          this.offset += 5;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) this.fail();
      }
      this.offset += 1;
    }
    this.fail();
  }
  private number(): void {
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.content.slice(this.offset))?.[0];
    if (token === undefined) this.fail();
    this.offset += token.length;
  }
}

export function parseRateLimitJsonWire(value: string | Uint8Array, maxBytes: number): unknown {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  if (bytes.byteLength > maxBytes) throw new RateLimitJsonError('message_too_large');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (cause) { throw new RateLimitJsonError('malformed_message', { cause }); }
  new RateLimitJsonScanner(text).scan();
  try { return JSON.parse(text); }
  catch (cause) { throw new RateLimitJsonError('malformed_message', { cause }); }
}
