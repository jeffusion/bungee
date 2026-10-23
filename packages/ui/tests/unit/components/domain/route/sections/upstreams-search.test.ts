import { expect, test } from 'bun:test';
import { groupTargets, moveTarget } from '../../../../../../src/components/domain/route/sections/upstream-groups';

const initial = () => ({ endpoints: [
  { _uid: 'hidden', target: 'https://hidden.test', description: 'private', priority: 1, weight: 100, _position: 0 },
  { _uid: 'visible', target: 'https://ALPHA.test', description: 'Primary Pool', priority: 5, weight: 20, _position: 1 },
  { _uid: 'other', target: 'https://other.test', description: 'Backup Pool', priority: 9, weight: 30, _position: 2 },
] });
const reference = () => ({id:'child', service_id:'child-service', priority:5, position:3, weight:100, is_disabled:false});

test('search trims and ignores case, preserving complete group and endpoint indices without mutation', () => {
  const owner = initial(), before = structuredClone(owner);
  for (const query of [' alpha ', 'PRIMARY pool']) {
    const groups = groupTargets(owner, [], query);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({priority:5,groupIndex:1});
    expect(groups[0].targets[0]).toMatchObject({kind:'endpoint',originalIndex:1,key:'endpoint:visible'});
  }
  expect(groupTargets(owner, [], 'no-match')).toEqual([]);
  expect(groupTargets(owner, [], '  ').flatMap(group => group.targets.map(target => target.key))).toEqual(['endpoint:hidden','endpoint:visible','endpoint:other']);
  expect(owner).toEqual(before);
});

test('mixed search resolves service names without treating references as endpoints', () => {
  const owner = {...initial(), service_references:[reference()]};
  const groups = groupTargets(owner, [{_uid:'child-service',name:'Nested Pool',endpoints:[]}], ' NESTED ');
  expect(groups[0]).toMatchObject({priority:5,groupIndex:1});
  expect(groups[0].targets).toEqual([expect.objectContaining({kind:'service',key:'service:child'})]);
  expect(groupTargets(owner, [], 'CHILD-service')[0].targets[0].kind).toBe('service');
});

test('mixed reordering writes a single position space and preserves identities and bindings', () => {
  const owner = {...initial(), service_references:[reference()]};
  owner.endpoints[1] = {...owner.endpoints[1], plugins:[{_uid:'binding', name:'plugin',options:{keep:true}}]} as any;
  const before = structuredClone(owner);
  const moved = moveTarget(owner, 'service:child', {groupIndex:1,targetKey:'endpoint:visible'});
  expect(moved.service_references?.[0]).toMatchObject({id:'child',position:1,priority:2});
  expect(moved.endpoints?.[1]).toMatchObject({_uid:'visible',_position:2,priority:2,plugins:[{_uid:'binding', name:'plugin',options:{keep:true}}]});
  expect(moved.endpoints?.map(endpoint => endpoint.priority)).toEqual([1,2,3]);
  expect(moved.endpoints?.some(endpoint => 'originalIndex' in endpoint)).toBe(false);
  expect(owner).toEqual(before);
  const after = moveTarget(moved, 'service:child', {groupIndex:1,targetKey:'endpoint:visible',after:true});
  expect(after.service_references?.[0].position).toBe(2);
});

for (const insertIndex of [0,1,2,3]) test(`new group insertion respects removed source groups at boundary ${insertIndex}`, () => {
  const moved = moveTarget(initial(), 'endpoint:visible', {insertIndex});
  expect(moved.endpoints?.map(endpoint => endpoint._uid)).toEqual(insertIndex === 0 ? ['visible','hidden','other'] : insertIndex === 3 ? ['hidden','other','visible'] : ['hidden','visible','other']);
  expect(moved.endpoints?.map(endpoint => endpoint.priority)).toEqual([1,2,3]);
});

test('cross-group merge removes empty sources; references-only Route retains absent endpoints', () => {
  const owner = {service_references:[reference(),{...reference(),id:'second',service_id:'other',priority:9,position:4}]};
  const moved = moveTarget(owner, 'service:child', {groupIndex:1});
  expect(moved.endpoints).toBeUndefined();
  expect(moved.service_references?.map(item => [item.id,item.priority,item.position])).toEqual([['second',1,0],['child',1,1]]);
});

test('unknown and self drag targets leave the full owner untouched', () => {
  const owner = initial();
  expect(moveTarget(owner,'missing',{insertIndex:0})).toBe(owner);
  expect(moveTarget(owner,'endpoint:visible',{groupIndex:1,targetKey:'endpoint:visible'})).toBe(owner);
  expect(moveTarget(owner,'endpoint:visible',{groupIndex:1,targetKey:'missing'})).toBe(owner);
  expect(moveTarget(owner,'endpoint:visible',{insertIndex:-1})).toBe(owner);
});
