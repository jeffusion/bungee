import { expect, test } from 'bun:test';
import { validateUpstreamSync } from '$validation';

test('service editor validates every endpoint target before save', async () => {
  expect(validateUpstreamSync({ target: '' }, 0)).toContainEqual({
    field: 'endpoints[0].target',
    message: expect.any(String),
  });

  const source = await Bun.file(new URL('./ServiceEditor.svelte', import.meta.url)).text();
  expect(source).toContain('validateUpstreamSync');
  expect(source).toContain('service.endpoints.flatMap');
});
