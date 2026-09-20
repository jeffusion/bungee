import { describe, expect, test } from 'bun:test';
import { normalizeText, portablePath } from './portable-text';

describe('portable text helpers', () => {
  test('normalizes Windows separators independently of the host platform', () => {
    expect(portablePath(String.raw`Users\alice\fixture/file.txt`)).toBe('Users/alice/fixture/file.txt');
  });

  test('normalizes CRLF and CR text to LF', () => {
    expect(normalizeText('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });
});
