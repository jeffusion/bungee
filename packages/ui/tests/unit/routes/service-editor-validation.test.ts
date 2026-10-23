import { expect, test } from 'bun:test';
import { validateUpstreamSync } from '$validation';

test('rejects an empty endpoint target', () => {
  expect(validateUpstreamSync({ target: '' }, 0)).toContainEqual({
    field: 'endpoints[0].target',
    message: expect.any(String),
  });
});

test('service references reject duplicate, missing and cyclic targets without mutating drafts', async () => {
  const { validateServiceReferences } = await import('../../../src/validation/service-references');
  const { serviceReference } = await import('../../helpers/service-references');
  const leaf = { _uid: 'leaf', name: 'leaf', endpoints: [] };
  const owner = { _uid: 'owner', name: 'owner', endpoints: [], service_references: [serviceReference('leaf')] };
  const before = structuredClone(owner);
  expect(validateServiceReferences(owner.service_references, [leaf, owner], owner)).toEqual([]);
  expect(validateServiceReferences([serviceReference('leaf'), serviceReference('leaf')], [leaf], owner)).toContainEqual({ field: 'service_references', message: expect.stringContaining('重复') });
  expect(validateServiceReferences([serviceReference('missing')], [leaf], owner)).toContainEqual({ field: 'service_references', message: expect.stringContaining('不存在') });
  const cyclic = { ...leaf, service_references: [serviceReference('owner')] };
  expect(validateServiceReferences(owner.service_references, [cyclic, owner], owner)).toContainEqual({ field: 'service_references', message: expect.stringContaining('循环') });
  expect(owner).toEqual(before);
});
