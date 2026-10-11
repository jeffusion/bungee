import { expect, test } from 'bun:test';
import { groupUpstreams, flattenGroups } from '../../../../../../src/components/domain/route/sections/upstream-groups';

const initial = () => [
  { _uid: 'hidden', target: 'https://hidden.test', description: 'private', priority: 1, weight: 100 },
  { _uid: 'visible', target: 'https://ALPHA.test', description: 'Primary Pool', priority: 5, weight: 20 },
  { _uid: 'other', target: 'https://other.test', description: 'Backup Pool', priority: 9, weight: 30 },
];

test('target/description search trims and ignores case; clearing restores every endpoint without mutation', () => {
  const endpoints = initial(), before = structuredClone(endpoints);
  for (const query of [' alpha ', 'PRIMARY pool']) {
    const groups = groupUpstreams(endpoints, query);
    expect(groups).toHaveLength(1);
    expect(groups[0].priority).toBe(5);
    expect(groups[0].groupIndex).toBe(1);
    expect(groups[0].upstreams.map((u: any) => u.originalIndex)).toEqual([1]);
  }
  expect(groupUpstreams(endpoints, 'no-match')).toEqual([]);
  expect(groupUpstreams(endpoints, '  ').flatMap((g: any) => g.upstreams.map((u: any) => u._uid))).toEqual(['hidden', 'visible', 'other']);
  expect(endpoints).toEqual(before);
});

test('flattened priorities are consecutive and projection indices never persist', () => {
  expect(flattenGroups(groupUpstreams(initial())).map(endpoint => endpoint.priority)).toEqual([1, 2, 3]);
  expect(flattenGroups(groupUpstreams(initial())).some(endpoint => 'originalIndex' in endpoint)).toBe(false);
});
