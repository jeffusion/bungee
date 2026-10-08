import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import WebSocket from '@bungee/ws-client';
import {
  cleanupGatewayFixture, createGatewayFixture, reservePortBlock, releasePortBlock, quarantinePortBlock,
  startTrackedGatewayMaster, stopOwnedMaster, waitForHealth, waitUntil, requestJson, recordOwnedWorkers,
  type GatewayFixture, type PortLease, type OwnedMaster, type GatewayMasterStartupState,
} from './support/token-stats-gateway';

let fixture:GatewayFixture;
let lease:PortLease;
let master:OwnedMaster|undefined;
let upstream:ReturnType<typeof Bun.serve>;
const startup:GatewayMasterStartupState={attempted:false,errors:[]};
const received:string[]=[];
let handshakeCount=0;
let generation=0;
const sockets=new Set<WebSocket>();
const SERVICE='10000000-0000-4000-8000-000000000021';
const aggregate=(enabled=true)=>({plugin_activations:[{plugin_name:'token-metering'},{plugin_name:'token-stats'}],logical_configuration:{publication:{drain_start_timeout_ms:5000,drain_timeout_ms:10000,worker_exit_timeout_ms:10000},plugins:[],
  services:[{id:SERVICE,position:1,name:'ws-fixture',plugins:[],endpoints:[{id:'20000000-0000-4000-8000-000000000021',position:1,target:`http://127.0.0.1:${upstream.port}`,weight:100,priority:1,is_disabled:false,plugins:[]}]}],
  routes:[{id:'30000000-0000-4000-8000-000000000021',position:1,path:'/v1/responses',service_id:SERVICE,plugins:[],websocket:{enabled}},
    {id:'30000000-0000-4000-8000-000000000022',position:2,path:'/disabled',service_id:SERVICE,plugins:[]}],
}});
const management=()=>`http://127.0.0.1:${lease.base}`;
const proxy=()=>`ws://127.0.0.1:${lease.block.ports[1]}`;
async function publish(enabled=true,wait=true) {
  const snapshot=await requestJson(`${management()}/api/config`,{},fixture);
  const mutation=randomUUID();
  const result=await requestJson(`${management()}/api/config`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({expected_revision:(snapshot.body as any).revision,mutation_id:mutation,aggregate:aggregate(enabled)})},fixture);
  expect(result.response.status).toBe(202);
  if (wait) await waitUntil(async()=>{
    const result=await requestJson(`${management()}/api/config/operations/${mutation}`,{},fixture);
    const state=(result.body as any).operation?.state;
    if (['failed','degraded'].includes(state)) throw new Error(`publication ${state}: ${result.text}`);
    return state==='converged';
  },'WebSocket fixture publication did not converge',35_000);
  const runtime=await requestJson(`${management()}/api/config/runtime`,{},fixture);
  await recordOwnedWorkers(master!,(runtime.body as any).workers ?? []);
  return mutation;
}
function connect(path='/v1/responses'):Promise<WebSocket> {
  return new Promise((resolve,reject)=>{
    const socket=new WebSocket(`${proxy()}${path}`,{headers:{authorization:'Bearer fixture-api-key','x-bungee-internal-data-identity':'forged'}});
    sockets.add(socket);
    const timer=setTimeout(()=>{socket.terminate();reject(new Error('WebSocket client handshake deadline'));},5000);
    socket.once('open',()=>{clearTimeout(timer);resolve(socket);});
    socket.once('error',error=>{clearTimeout(timer);reject(error);});
    socket.once('close',()=>sockets.delete(socket));
  });
}
async function rejected(path:string) {
  return new Promise<number>((resolve,reject)=>{
    const socket=new WebSocket(`${proxy()}${path}`);
    socket.once('unexpected-response',(_,response)=>{response.resume();resolve(response.statusCode!);socket.terminate();});
    socket.once('open',()=>{socket.terminate();reject(new Error('disabled route unexpectedly upgraded'));});
    socket.on('error',()=>undefined);
  });
}
async function stats() {
  const result=await requestJson(`${management()}/api/plugins/token-stats/control/stats?range=1h&groupBy=model`,{},fixture);
  if (!result.response.ok) throw new Error(result.text);
  return result.body as any;
}
beforeAll(async()=>{
  fixture=await createGatewayFixture();lease=await reservePortBlock();
  upstream=Bun.serve({hostname:'127.0.0.1',port:0,
    fetch(request,server){
      expect(request.headers.get('authorization')).toBe('Bearer fixture-api-key');
      expect(request.headers.has('x-bungee-internal-data-identity')).toBe(false);
      handshakeCount++;
      if (server.upgrade(request)) return;
      return new Response('fixture only',{status:400});
    },
    websocket:{message(socket,message){
      if (typeof message!=='string') {socket.send(message);return;}
      received.push(message);
      const create=JSON.parse(message);
      if (create.type!=='response.create') {socket.send(message);return;}
      const id=`fixture-response-${++generation}`;
      const response={id,object:'response',model:'gpt-4o-mini',output:[]};
      socket.send(JSON.stringify({type:'response.created',stream_id:create.stream_id,response}));
      if (create.model==='unfinished') return;
      const terminal={type:'response.completed',stream_id:create.stream_id,response:{...response,usage:{input_tokens:17,output_tokens:7,input_tokens_details:{cached_tokens:5}}}};
      socket.send(JSON.stringify(terminal));socket.send(JSON.stringify(terminal));
    }},
  });
  master=await startTrackedGatewayMaster(startup,fixture,lease);await waitForHealth(master,lease.base,fixture);await publish();
},90_000);
afterAll(async()=>{
  for(const socket of sockets)socket.terminate();
  const errors:unknown[]=[...startup.errors];let shutdown=false;let ports=false;
  try{if(master){await stopOwnedMaster(master);shutdown=true;}}catch(error){errors.push(error);}
  try{await upstream?.stop(true);if(lease){await releasePortBlock(lease);ports=true;}}catch(error){if(lease)quarantinePortBlock(lease);errors.push(error);}
  if(fixture)try{const removed=await cleanupGatewayFixture(fixture,{startupAttempted:startup.attempted,master,shutdownVerified:shutdown,portsVerifiedClosed:ports});if(!removed)errors.push(new Error(`retained fixture: ${fixture.root}`));}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors,'WebSocket real process cleanup failed');
},45_000);

test('real ingress + worker preserves messages and persists each generation before connection close',async()=>{
  expect(await rejected('/disabled')).toBe(426);expect(handshakeCount).toBe(0);
  const socket=await connect();
  const completed:string[]=[];
  socket.on('message',(data,binary)=>{if(!binary){const event=JSON.parse(data.toString());if(event.type==='response.completed')completed.push(event.response.id);}});
  for(let i=0;i<2;i++)socket.send(JSON.stringify({type:'response.create',model:'gpt-4o-mini',input:[{role:'user',content:'local fixture'}],stream_id:`lane-${i}`}));
  await waitUntil(async()=>completed.length===4,'terminal events did not cross both hops',5000);
  await waitUntil(async()=>{const result=await stats();return result.logicalRequests===2 && result.officialInputTokens===34 && result.officialOutputTokens===14 && result.cacheReadTokens===10;},'WebSocket per-generation stats missing',8000);
  expect(socket.readyState).toBe(WebSocket.OPEN);expect(received).toHaveLength(2);expect(handshakeCount).toBe(1);
  socket.send(JSON.stringify({type:'response.create',model:'unfinished',input:[]}));
  await waitUntil(async()=>received.length===3,'unfinished create did not reach upstream',3000);
  const closed=new Promise<void>(resolve=>socket.once('close',()=>resolve()));socket.close();await closed;
  await waitUntil(async()=>(await stats()).logicalRequests===3,'unfinished generation was not recorded',8000);
  const final=await stats();expect(final.officialInputTokens).toBe(34);expect(final.officialOutputTokens).toBe(14);expect(final.estimatedInputTokens).toBe(0);
},20_000);

test('publication drains an existing socket finitely and new disabled revision refuses Upgrade',async()=>{
  const socket=await connect();
  const start=Date.now();
  const close=new Promise<number>(resolve=>socket.once('close',code=>resolve(code)));
  await publish(false,false);
  expect(await close).toBe(1012);
  expect(Date.now()-start).toBeLessThan(15_000);
  await waitUntil(async()=>await rejected('/v1/responses')===426,'new revision did not reject WebSocket',10_000);
},30_000);
