import { hasLoneSurrogate } from '../config-storage/utf16';
import { PluginManifestCatalogError } from './parse-utils';

const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 8_192;
const MAX_STRING_LENGTH = 64 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

class JsonScanner {
  #offset = 0;
  #nodes = 0;

  constructor(private readonly content: string, private readonly source: string) {}

  scan(): void {
    if (new TextEncoder().encode(this.content).byteLength > MAX_BYTES) this.fail('manifest exceeds maximum size');
    this.value(0, '$');
    this.whitespace();
    if (this.#offset !== this.content.length) this.fail('invalid JSON token');
  }

  private fail(message: string): never {
    throw new PluginManifestCatalogError(this.source, `invalid JSON: ${message} at character ${this.#offset}`);
  }

  private whitespace(): void {
    while (this.#offset < this.content.length && ' \t\r\n'.includes(this.content[this.#offset] ?? '')) this.#offset += 1;
  }

  private take(expected: string): void {
    if (this.content[this.#offset] !== expected) this.fail(`expected ${expected}`);
    this.#offset += 1;
  }

  private value(depth: number, path: string): void {
    if (depth > MAX_DEPTH) this.fail('manifest exceeds maximum depth');
    this.#nodes += 1;
    if (this.#nodes > MAX_NODES) this.fail('manifest exceeds maximum node count');
    this.whitespace();
    const token = this.content[this.#offset];
    if (token === '{') this.object(depth, path);
    else if (token === '[') this.array(depth, path);
    else if (token === '"') this.string();
    else if (token === '-' || (token !== undefined && token >= '0' && token <= '9')) this.number();
    else if (this.content.startsWith('true', this.#offset)) this.#offset += 4;
    else if (this.content.startsWith('false', this.#offset)) this.#offset += 5;
    else if (this.content.startsWith('null', this.#offset)) this.#offset += 4;
    else this.fail('invalid JSON value');
  }

  private object(depth: number, path: string): void {
    this.take('{');
    this.whitespace();
    const keys = new Set<string>();
    if (this.content[this.#offset] === '}') { this.#offset += 1; return; }
    while (true) {
      if (this.content[this.#offset] !== '"') this.fail('object key must be a string');
      const key = this.string();
      if (keys.has(key)) this.fail(`duplicate object key ${key}`);
      if (FORBIDDEN_KEYS.has(key)) this.fail(`forbidden object key ${key}`);
      keys.add(key);
      this.whitespace();
      this.take(':');
      this.value(depth + 1, `${path}.${key}`);
      this.whitespace();
      const delimiter = this.content[this.#offset];
      if (delimiter === '}') { this.#offset += 1; return; }
      if (delimiter !== ',') this.fail('expected comma or closing brace');
      this.#offset += 1;
      this.whitespace();
    }
  }

  private array(depth: number, path: string): void {
    this.take('[');
    this.whitespace();
    if (this.content[this.#offset] === ']') { this.#offset += 1; return; }
    let index = 0;
    while (true) {
      this.value(depth + 1, `${path}[${index}]`);
      index += 1;
      this.whitespace();
      const delimiter = this.content[this.#offset];
      if (delimiter === ']') { this.#offset += 1; return; }
      if (delimiter !== ',') this.fail('expected comma or closing bracket');
      this.#offset += 1;
      this.whitespace();
    }
  }

  private string(): string {
    const start = this.#offset;
    this.take('"');
    while (this.#offset < this.content.length) {
      const character = this.content[this.#offset];
      if (character === '"') {
        this.#offset += 1;
        const decoded: unknown = JSON.parse(this.content.slice(start, this.#offset));
        if (typeof decoded !== 'string') this.fail('invalid JSON string');
        if (decoded.length > MAX_STRING_LENGTH) this.fail('string exceeds maximum length');
        if (hasLoneSurrogate(decoded)) this.fail('string contains a lone surrogate');
        return decoded;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) this.fail('invalid control character in string');
      if (character === '\\') {
        this.#offset += 1;
        const escapeCode = this.content[this.#offset];
        if (escapeCode === 'u') {
          const digits = this.content.slice(this.#offset + 1, this.#offset + 5);
          if (digits.length !== 4 || !/^[0-9A-Fa-f]{4}$/.test(digits)) this.fail('invalid unicode escape');
          this.#offset += 5;
          continue;
        }
        if (escapeCode === undefined || !'"\\/bfnrt'.includes(escapeCode)) this.fail('invalid string escape');
      }
      this.#offset += 1;
    }
    this.fail('unterminated string');
  }

  private number(): void {
    const rest = this.content.slice(this.#offset);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    const token = match?.[0];
    if (token === undefined) this.fail('invalid JSON number');
    this.#offset += token.length;
  }
}

export function parseBoundedJson(content: string, source: string): unknown {
  new JsonScanner(content, source).scan();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new PluginManifestCatalogError(source, 'invalid JSON', { cause: error });
  }
  return parsed;
}
