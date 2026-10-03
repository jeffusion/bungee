import {expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {createPluginControlHost} from '../../src/plugin-control/host';
import {loadPluginManifestRecord} from '../../src/plugin-manifest-catalog/manifest-filesystem';
import {PLUGIN_DURABLE_STATE_SCHEMA_SQL, PluginDurableStateStore} from '../../src/plugin-durable-state';
import {readResource as readKeyPolicy, readAdmissionRequirements, verifyDataPrincipal, readResourceCollection} from '../../../../plugins/key-access/server/control';
import {DurableRouteProtections} from '../../src/master-runtime/composition';

test('disabled resource reads expose only get/list without creating control, capabilities, or writes', async () => {
  const db = new Database(':memory:'); db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
  const state = new PluginDurableStateStore(db).forNamespace('key-access');
  state.execute({commandId: 'seed', mutations: [{key: 'policies', expectedVersion: 0, value: {protectedRouteIds: ['route'], credentials: [], byKey: {key1: {routes: null, models: ['gemini-2.5-pro']}}}}]});
  const before = state.list();
  const raw = await loadPluginManifestRecord(new URL('../../../../plugins/key-access', import.meta.url).pathname);
  const record = {...raw, runtimeHash: 'sha256:'+'0'.repeat(64)} as any;
  let creates = 0, starts = 0, writes = 0, loads = 0, capabilities = 0;
  const host = createPluginControlHost({records: [record], durableState: () => ({...state, execute(command) {writes++;return state.execute(command);}}),
    secretStores: {create() {capabilities++;throw new Error('unexpected secret capability');}, revoke() {}, clear() {}},
    storage: {create() {capabilities++;throw new Error('unexpected storage capability');}},
    loadControl: async () => {loads++;return {
      readAdmissionRequirements, verifyDataPrincipal, readResourceCollection,
      createControl() {creates++;return {api: [], rpc: [], start() {starts++;}, dispose() {}};},
      readResource(resource, id, readonlyState) {
        expect(Object.keys(readonlyState).sort()).toEqual(['get', 'list']);
        expect(Object.isFrozen(readonlyState)).toBe(true);
        expect('execute' in readonlyState).toBe(false);
        expect(readonlyState.list()).toEqual(before);
        return readKeyPolicy(resource, id, readonlyState);
      },
    };},
  });
  try {
    expect(host.status('key-access')).toBe('inactive');
    expect(await host.readResource('key-access', 'api-key', 'key1')).toEqual({value: {routes: null, models: ['gemini-2.5-pro']}});
    expect(await host.readResource('key-access', 'api-key', 'missing')).toEqual({value: null});
    await expect(host.readResource('key-access', 'undeclared', 'key1')).rejects.toThrow('not declared');
    expect(host.get('key-access')).toBeNull();
    expect(host.status('key-access')).toBe('inactive');
    expect({creates, starts, writes, capabilities, loads}).toEqual({creates: 0, starts: 0, writes: 0, capabilities: 0, loads: 1});
    expect(await host.readResourceCollection('key-access', 'api-key')).toEqual([]);
    expect(await host.readAdmissionRequirements('key-access')).toEqual(['route']);
    expect(await host.verifyDataPrincipal('key-access', {domain: 'data', keyId: 'missing', credentialVersion: 1})).toBe(false);
    expect(state.list()).toEqual(before);
    expect(db.query('SELECT COUNT(*) AS count FROM plugin_durable_commands').get()).toEqual({count: 1});
  } finally {await host.dispose();db.close();}
});

test('missing admission reader or artifact cannot clear a durable protection; only explicit empty routes can', async () => {
  const db = new Database(':memory:'); db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
  const store = new PluginDurableStateStore(db);
  const persisted = store.forNamespace('core-route-protection');
  persisted.execute({commandId:'seed',mutations:[{key:'key-access',expectedVersion:0,value:{plugin:'key-access',routeIds:['protected']}}]});
  const raw = await loadPluginManifestRecord(new URL('../../../../plugins/key-access', import.meta.url).pathname);
  const record = {...raw,runtimeHash:'sha256:'+'0'.repeat(64)} as any;
  let reader: (() => readonly string[]) | undefined;
  const host = createPluginControlHost({records:[record],durableState:name=>store.forNamespace(name),
    secretStores:{create(){throw Error('must remain inactive');},revoke(){},clear(){}},
    storage:{create(){throw Error('must remain inactive');}},
    loadControl:async()=>({createControl(){throw Error('must remain inactive');},get readAdmissionRequirements(){return reader;}}),
  });
  try {
    const guards = new DurableRouteProtections(persisted);
    await expect(host.readAdmissionRequirements('key-access')).rejects.toMatchObject({code:'not_declared'});
    await guards.refresh(['key-access'],host);
    expect(guards.requirements()).toEqual([{plugin:'key-access',routeIds:['protected']}]);
    await guards.refresh([],host); // The entire plugin directory disappeared.
    expect(new DurableRouteProtections(persisted).requirements()).toEqual(guards.requirements());
    reader=()=>{throw Error('read failed');};
    await guards.refresh(['key-access'],host);
    expect(guards.requirements()).toEqual([{plugin:'key-access',routeIds:['protected']}]);
    reader=()=>[];
    await guards.refresh(['key-access'],host);
    expect(guards.requirements()).toEqual([]);
    expect(new DurableRouteProtections(persisted).requirements()).toEqual([]);
    expect(host.status('key-access')).toBe('inactive');
  } finally {await host.dispose();db.close();}
});

test('failed immutable module load retries; successful module reuse still reads fresh durable state', async () => {
  const db = new Database(':memory:'); db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
  const state = new PluginDurableStateStore(db).forNamespace('key-access');
  const raw = await loadPluginManifestRecord(new URL('../../../../plugins/key-access',import.meta.url).pathname);
  const record = {...raw,runtimeHash:'sha256:'+'0'.repeat(64)} as any;
  let loads=0;
  const host=createPluginControlHost({records:[record],durableState:()=>state,
    secretStores:{create(){throw Error('unexpected capability');},revoke(){},clear(){}},
    storage:{create(){throw Error('unexpected capability');}},loadControl:async()=>{
      if (++loads===1) throw Error('temporary artifact read failure');
      return {createControl(){throw Error('must stay inactive');},readAdmissionRequirements};
    },
  });
  try {
    await expect(host.readAdmissionRequirements('key-access')).rejects.toThrow('temporary artifact read failure');
    expect(await host.readAdmissionRequirements('key-access')).toEqual([]);
    state.execute({commandId:'write',mutations:[{key:'policies',expectedVersion:0,value:{protectedRouteIds:['fresh-route'],credentials:[],byKey:{}}}]});
    expect(await host.readAdmissionRequirements('key-access')).toEqual(['fresh-route']);
    expect(loads).toBe(2);
    expect(host.status('key-access')).toBe('inactive');
  } finally {await host.dispose();db.close();}
});
