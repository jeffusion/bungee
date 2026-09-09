import { expect, test } from 'bun:test';
import { serializeErrorChain } from '../../src/master-runtime/error-chain';

test('redacts quoted, key-value, query, and Bearer credentials through the bounded error chain', () => {
  const message = [
    '{"access_token":"oauth-secret","refresh_token":"refresh-secret","accessToken":"oauth-secret"}',
    "{'refreshToken':'refresh-secret','authorization':'Bearer oauth-secret','api_key':'oauth-secret'}",
    'apiKey=oauth-secret password=pw-secret cookie=session=oauth-secret set-cookie=session=refresh-secret',
    '?access_token=oauth-secret&refresh_token=refresh-secret authorization=Bearer oauth-secret',
  ].join(' ');
  const leaf = new Error('refresh_token=refresh-secret password=pw-secret');
  const nested = new Error(message, { cause: leaf });
  const aggregate = new AggregateError([
    new Error('accessToken=oauth-secret'),
    new Error('refreshToken=refresh-secret'),
    new Error('password=pw-secret'),
  ], 'authorization: Bearer oauth-secret', { cause: nested });
  const failure = new Error(message, { cause: aggregate });
  const serialized = serializeErrorChain(failure);
  const output = JSON.stringify(serialized);

  expect(serialized.message).toContain('[REDACTED]');
  expect(serialized.stack).toContain('[REDACTED]');
  expect(serialized.cause?.cause?.cause).toMatchObject({ message: 'refresh_token=[REDACTED] password=[REDACTED]' });
  expect(serialized.cause?.errors?.[0].message).toContain('[REDACTED]');
  for (const secret of ['oauth-secret', 'refresh-secret', 'pw-secret']) {
    expect(output).not.toContain(secret);
  }
});

test('does not redact ordinary diagnostic key-value text', () => {
  const message = 'token budget=128; key=value; aggregate count=2';
  expect(serializeErrorChain(new Error(message)).message).toBe(message);
});
