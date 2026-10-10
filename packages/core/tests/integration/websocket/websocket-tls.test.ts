import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

test('WSS verifies upstream certificates and accepts an explicitly trusted local CA',async()=>{
  const directory=await mkdtemp('/tmp/bungee-ws-tls-');
  const key=join(directory,'key.pem'),cert=join(directory,'cert.pem');
  let upstream:ReturnType<typeof Bun.serve>|undefined;
  try{
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
    upstream=Bun.serve({hostname:'127.0.0.1',port:0,tls:{key:await readFile(key,'utf8'),cert:await readFile(cert,'utf8')},
      fetch(request,server){if(server.upgrade(request))return;return new Response('not WS',{status:400});},
      websocket:{message(socket,message){socket.send(message);}},
    });
    const source=`import {createWebSocketBridge} from ${JSON.stringify(new URL('../../../src/websocket/index.ts',import.meta.url).pathname)};
      import WebSocket from ${JSON.stringify(Bun.resolveSync('@bungee/ws-client',process.cwd()))};
      const bridge=createWebSocketBridge();
      const server=Bun.serve({hostname:'127.0.0.1',port:0,websocket:bridge.websocket,fetch:(request,native)=>bridge.upgrade(request,native,{url:${JSON.stringify(`wss://127.0.0.1:${upstream.port}/echo`)},headers:new Headers()})});
      const result=await new Promise((resolve,reject)=>{
        const socket=new WebSocket('ws://127.0.0.1:'+server.port+'/echo');
        const timer=setTimeout(()=>{socket.terminate();reject(Error('TLS fixture deadline'));},5000);
        socket.on('error',()=>{});
        socket.once('unexpected-response',(_,response)=>{clearTimeout(timer);response.resume();socket.terminate();resolve('status:'+response.statusCode);});
        socket.once('open',()=>socket.send('verified WSS'));
        socket.once('message',message=>{clearTimeout(timer);resolve(message.toString());socket.close();});
      });
      await bridge.stop();await server.stop(true);console.log(result);`;
    const run=async(trusted:boolean)=>{
      const child=Bun.spawn([process.execPath,'-e',source],{env:{...process.env,NODE_EXTRA_CA_CERTS:trusted?cert:undefined,NODE_TLS_REJECT_UNAUTHORIZED:'1'},stdout:'pipe',stderr:'pipe'});
      const output=await new Response(child.stdout).text();const error=await new Response(child.stderr).text();
      expect(await child.exited).toBe(0);if(error.includes('TLS fixture deadline'))throw Error(error);return output.trim();
    };
    expect(await run(false)).toBe('status:502');
    expect(await run(true)).toBe('verified WSS');
  }finally{await upstream?.stop(true);await rm(directory,{recursive:true,force:true});}
},15_000);
