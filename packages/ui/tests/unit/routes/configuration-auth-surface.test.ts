import { expect, test } from 'bun:test';

test('settings preserve validation, accepted publication identity and local import preview', async () => {
  const source = await Bun.file(new URL('../../../src/routes/Configuration.svelte', import.meta.url)).text();
  expect(source).not.toContain('draft.auth');
  expect(source).toContain('validSignature === signature');
  expect(source).toContain('disabled={locked || reviewOpen || !!imported}');
  const dispatch = source.slice(source.indexOf('onDispatch:'), source.indexOf('onOperation:', source.indexOf('onDispatch:')));
  expect(dispatch).not.toContain('sessionStorage');
  expect(dispatch).not.toContain('retainAccepted');
  expect(source).toContain('retainAccepted(state.operation.mutation_id)');
  expect(source).not.toContain('localStorage.setItem');
  const selection = source.slice(source.indexOf('async function selectImport'), source.indexOf('function cancelReview'));
  expect(selection).toContain('parseImportPreview');
  expect(selection).not.toContain('importConfig(');
  expect(selection).not.toContain('validateAggregate(');
});
