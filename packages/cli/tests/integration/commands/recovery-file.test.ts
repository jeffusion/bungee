import {afterEach, expect, test} from 'bun:test';
import {mkdtemp, rm, writeFile, symlink, rename, link} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {WindowsAclAdapter, WindowsAclSnapshot} from '@jeffusion/bungee-types/daemon-file';
import {openRecoveryInputFile} from '../../../src/commands/recovery-file';

const dirs: string[] = [];
afterEach(async()=>{for(const dir of dirs.splice(0)) await rm(dir,{recursive:true,force:true});});
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'bungee-recovery-input-'));dirs.push(dir);
  const path=join(dir,'input.json');await writeFile(path,'{"kind":"identity"}',{mode:0o600});
  return {dir,path};
}
const secure: WindowsAclSnapshot={ownerSid:'S-1-5-21-1',currentSid:'S-1-5-21-1',entries:['S-1-5-21-1','S-1-5-18','S-1-5-32-544'].map(sid=>({sid,access:'allow' as const,rights:2032127,inheritance:0,propagation:0,inherited:false}))};
function adapter(read: WindowsAclAdapter['read']): WindowsAclAdapter {
  return {read,async set(){throw new Error('untrusted recovery input must not have its ACL repaired');}};
}

test('Windows recovery input accepts a verified descriptor and rejects public or inherited ACLs without repair',async()=>{
  const {path}=await fixture();
  const file=await openRecoveryInputFile(path,{platform:'win32',windowsAcl:adapter(async()=>secure)});
  try{expect(await file.readFile('utf8')).toBe('{"kind":"identity"}');}finally{await file.close();}
  for(const entries of [
    [...secure.entries,{...secure.entries[0]!,sid:'S-1-1-0'}],
    secure.entries.map(entry=>({...entry,inherited:true})),
    secure.entries.filter(entry=>entry.sid!==secure.currentSid),
  ]) await expect(openRecoveryInputFile(path,{platform:'win32',windowsAcl:adapter(async()=>({...secure,entries}))})).rejects.toThrow('Windows ACL validation failed');
});

test('recovery input rejects symlinks, hardlinks, directories and oversized files before ACL inspection',async()=>{
  const {dir,path}=await fixture();
  const alias=join(dir,'alias.json');await symlink(path,alias);
  const oversized=join(dir,'large.json');await writeFile(oversized,'x'.repeat(8193),{mode:0o600});
  const options={platform:'win32' as const,windowsAcl:adapter(async()=>{throw Error('unexpected ACL read');})};
  for(const unsafe of [alias,dir,oversized]) await expect(openRecoveryInputFile(unsafe,options)).rejects.toThrow('owner-only regular file');
  const hardlink=join(dir,'hardlink.json');await link(path,hardlink);
  await expect(openRecoveryInputFile(hardlink,options)).rejects.toThrow('owner-only regular file');
});

test('Windows recovery input rejects path replacement during ACL inspection',async()=>{
  const {path}=await fixture();
  await expect(openRecoveryInputFile(path,{platform:'win32',windowsAcl:adapter(async()=>{
    await rename(path,path+'.old');await writeFile(path,'{"replacement":true}',{mode:0o600});return secure;
  })})).rejects.toThrow('owner-only regular file');
});

test('Windows recovery input fails closed when the ACL probe fails',async()=>{
  const {path}=await fixture();
  await expect(openRecoveryInputFile(path,{platform:'win32',windowsAcl:adapter(async()=>{throw Error('ACL probe failed');})})).rejects.toThrow('ACL probe failed');
});

 test('Windows recovery input rejects a compliant DACL with missing or foreign ownership',async()=>{
  const {path}=await fixture();
  for(const ownerSid of [undefined,'S-1-5-21-2']) {
    await expect(openRecoveryInputFile(path,{platform:'win32',windowsAcl:adapter(async()=>({...secure,ownerSid}))})).rejects.toThrow('owned by the current user');
  }
});
