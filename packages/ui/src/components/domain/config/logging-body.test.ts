import { describe, expect, test } from 'bun:test';
import { LOGGING_BODY_DEFAULTS, resolveLoggingBody, withLoggingBody, type LoggingValue } from './logging-body';

describe('logging body model (render-time defaults, copy-on-edit)', () => {
  test('does not bind a missing logging value back as null during mount', async () => {
    const source = await Bun.file(new URL('./LoggingEditor.svelte', import.meta.url)).text();

    expect(source).toContain('export let value: any;');
    expect(source).not.toContain('export let value: any = null;');
  });

  test('resolves display defaults from an unset value without mutating it', () => {
    // Given
    const value: LoggingValue = null;

    // When
    const body = resolveLoggingBody(value);

    // Then
    expect(body).toEqual(LOGGING_BODY_DEFAULTS);
    expect(value).toBeNull();
  });

  test('resolves display defaults for a missing body key without mutating the value', () => {
    // Given
    const value: LoggingValue = { other: true } as unknown as LoggingValue;

    // When
    const body = resolveLoggingBody(value);

    // Then
    expect(body).toEqual(LOGGING_BODY_DEFAULTS);
    expect(value).toEqual({ other: true });
  });

  test('returns the existing own fields when the body is partially set', () => {
    // Given
    const value: LoggingValue = { body: { enabled: true } } as unknown as LoggingValue;

    // When
    const body = resolveLoggingBody(value);

    // Then
    expect(body).toEqual({ enabled: true, max_size: 5120, retention_days: 1 });
  });
});

describe('withLoggingBody (copy-on-edit)', () => {
  test('produces a new value object and leaves the original untouched', () => {
    // Given
    const original: LoggingValue = { body: { enabled: false, max_size: 5120, retention_days: 1 } };

    // When
    const next = withLoggingBody(original, { enabled: true });

    // Then
    expect(next).not.toBe(original);
    expect((next as { body: { enabled: boolean } }).body.enabled).toBe(true);
    expect(original.body).toEqual({ enabled: false, max_size: 5120, retention_days: 1 });
  });

  test('materializes defaults once on first edit of an unset value', () => {
    // Given
    const value: LoggingValue = null;

    // When
    const next = withLoggingBody(value, { retention_days: 7 });

    // Then
    expect((next as { body: unknown }).body).toEqual({ enabled: false, max_size: 5120, retention_days: 7 });
    expect(value).toBeNull();
  });
});
