import {expect,test} from 'bun:test';
import {createRemotePluginStorageFactory} from '../../../src/plugin-state/storage-rpc';

test('generic observation invocation binds its namespace and revokes together with KV',async()=>{
  const calls:unknown[]=[];
  const factory=createRemotePluginStorageFactory(async()=>null,async(namespace,operation,args)=>{calls.push({namespace,operation,args});return 7;});
  const storage=factory.create('observer');
  expect(await storage.invokeObservation!<number>('queryStats',[{routeId:'r'}])).toBe(7);
  expect(calls).toEqual([{namespace:'observer',operation:'queryStats',args:[{routeId:'r'}]}]);
  expect(storage.uncached!()).toBe(storage);
  factory.revoke(storage);
  await expect(storage.invokeObservation!('recordSample',[])).rejects.toThrow('plugin_storage_capability_revoked');
  expect(calls).toHaveLength(1);
  expect(createRemotePluginStorageFactory(async()=>null).create('ungranted').invokeObservation).toBeUndefined();
});
