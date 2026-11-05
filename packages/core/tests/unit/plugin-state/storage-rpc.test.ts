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

test('idle remote flush completes without transport even when the master is unavailable',async()=>{
  let sends=0;
  const storage=createRemotePluginStorageFactory(async()=>{sends++;throw new Error('master unavailable');}).create('idle');
  await expect(storage.flush!()).resolves.toBeUndefined();
  expect(sends).toBe(0);
});

test('remote flush waits for writes accepted before the call and does not chase later writes',async()=>{
  const resolvers:Array<(value:unknown)=>void>=[];
  const operations:string[]=[];
  const storage=createRemotePluginStorageFactory((_namespace,operation)=>{
    operations.push(operation);
    return new Promise(resolve=>{resolvers.push(resolve);});
  }).create('pending');
  const first=storage.set('a',{count:1});
  const second=storage.compareAndSet('a','count',1,2);
  let flushed=false;
  const flushedPromise=storage.flush!().then(()=>{flushed=true;});
  await Promise.resolve();
  expect(flushed).toBe(false);
  const later=storage.set('b',3);
  resolvers[0]!(null);
  await first;
  await Promise.resolve();
  expect(flushed).toBe(false);
  resolvers[1]!(true);
  await expect(second).resolves.toBe(true);
  await flushedPromise;
  expect(flushed).toBe(true);
  expect(operations).toEqual(['set','compareAndSet','set']);
  resolvers[2]!(null);
  await later;
});

test('a write failure rejects the original write and every waiting or later flush',async()=>{
  const failure=new Error('write transport failed');
  let rejectWrite!:(error:unknown)=>void;
  const storage=createRemotePluginStorageFactory((_namespace,operation)=>operation==='set'
    ? new Promise((_resolve,reject)=>{rejectWrite=reject;})
    : Promise.resolve(null)).create('failing');
  const write=storage.set('k',1);
  const writeOutcome=write.then(()=>null,error=>error);
  let flushSettled=false;
  const flushOutcome=storage.flush!().then(
    ()=>{flushSettled=true;return null;},
    error=>{flushSettled=true;return error;},
  );
  await Promise.resolve();
  expect(flushSettled).toBe(false);
  rejectWrite(failure);
  expect(await writeOutcome).toBe(failure);
  expect(await flushOutcome).toBe(failure);
  expect(flushSettled).toBe(true);
  await expect(storage.flush!()).rejects.toBe(failure);
});

test('revoked capabilities refuse flush',async()=>{
  const factory=createRemotePluginStorageFactory(async()=>null);
  const storage=factory.create('revoked');
  factory.revoke(storage);
  await expect(storage.flush!()).rejects.toThrow('plugin_storage_capability_revoked');
});
