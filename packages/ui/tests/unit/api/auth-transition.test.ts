import {afterEach,expect,test} from 'bun:test';
import {get} from 'svelte/store';
import {readAuthMode,verifyToken} from '../../../src/api/auth';
import {isAuthenticated,logout,restoreSession,token,beginAuthenticationHandoff} from '../../../src/stores/auth';
const originalFetch=globalThis.fetch;
function respond(body:unknown,status=200){globalThis.fetch=async()=>Response.json(body,{status});}
afterEach(()=>{globalThis.fetch=originalFetch;logout();});
test('Origin precheck consumes the authoritative public mode without inferring it from the browser hostname',async()=>{
  respond({mode:'anonymous',publicOrigin:'http://127.0.0.1:28089'});
  expect((await readAuthMode()).publicOrigin).toBe('http://127.0.0.1:28089');
});
test('unconfirmed new cookie session does not destroy the recovery wizard, while ordinary verification clears invalid state',async()=>{
  restoreSession({success:true});
  respond({success:false});
  expect((await verifyToken({preserveSessionOnFailure:true})).success).toBe(false);
  expect(get(isAuthenticated)).toBe(true);
  await verifyToken();
  expect(get(isAuthenticated)).toBe(false);
});
test('successful cookie verification restores the session without a legacy Key',async()=>{
  token.set(null);
  respond({success:true,subject:{id:'owner-id',provider:'local-accounts',},csrfToken:'verified-csrf'});
  expect((await verifyToken({preserveSessionOnFailure:true})).success).toBe(true);
  expect(get(isAuthenticated)).toBe(true);
  expect(get(token)).toBeNull();
});

test('background and late 401s cannot destroy a handoff, ordinary post-handoff 401 still logs out', async () => {
  const {api} = await import('../../../src/api/client');
  restoreSession({success:true});
  const responses: Array<(value:Response)=>void> = [];
  globalThis.fetch = () => new Promise<Response>(resolve=>responses.push(resolve));
  const before = api.get('/config/runtime').catch(error=>error);
  const end = beginAuthenticationHandoff();
  const during = api.get('/config/runtime').catch(error=>error);
  responses.shift()!(Response.json({error:'unauthorized'},{status:401}));
  await before;
  expect(get(isAuthenticated)).toBe(true);
  end();
  responses.shift()!(Response.json({error:'unauthorized'},{status:401}));
  await during;
  expect(get(isAuthenticated)).toBe(true);
  respond({error:'unauthorized'},401);
  await api.get('/config/runtime').catch(()=>{});
  expect(get(isAuthenticated)).toBe(false);
});

test('anonymous verify success establishes a session without a management subject or credential',async()=>{
  respond({success:true,mode:'anonymous'}); await verifyToken();
  expect(get(isAuthenticated)).toBe(true);expect(get(token)).toBeNull();
});
