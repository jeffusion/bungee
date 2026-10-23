import { expect, test } from 'bun:test';
import { validateUpstreamSync } from '$validation';

test('rejects an empty endpoint target', () => {
  expect(validateUpstreamSync({ target: '' }, 0)).toContainEqual({
    field: 'endpoints[0].target',
    message: expect.any(String),
  });
});
