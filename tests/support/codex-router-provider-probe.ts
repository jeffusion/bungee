/** Explicit real-provider acceptance. Uses Codex's existing auth, never reads/copies credentials. */
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {echoMcpScript} from './codex-router-cli-probe';

export async function probeCodexProvider(input:{model:string;baseUrl:string}) {
  const root=await mkdtemp(join(tmpdir(),'bungee-provider-probe-'));
  const nonce=randomUUID(), before=`before-${nonce}`, after=`after-${nonce}`, mcp=`mcp-${nonce}`;
  const initial=`keep-top-${nonce}\n${before}\nkeep-bottom-${nonce}\n`;
  const expected=initial.replace(before,after), path=join(root,'probe.txt'), audit=join(root,'mcp-audit.jsonl');
  const script=join(root,'echo-mcp.mjs');await writeFile(path,initial);await writeFile(script,echoMcpScript);
  const executable=Bun.which('codex');if(!executable)throw new Error('codex executable unavailable');
  const child=spawn(executable,['app-server','--stdio',
    '-c',`openai_base_url=${JSON.stringify(input.baseUrl)}`,'-c','model_provider="openai"',
    '-c','features.apps=false','-c','features.plugins=false',
    '-c',`mcp_servers={codex_fixture={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([script,audit])},startup_timeout_sec=10,tool_timeout_sec=10}}`],
    {cwd:root,stdio:['pipe','pipe','pipe']});
  let buffer='',closed=false;const pending=new Map<number,{resolve(value:any):void;reject(error:Error):void}>();
  const messages:any[]=[];
  child.stderr!.resume(); // May include auth/runtime internals: never echo it into the report.
  const exit=new Promise<void>(resolve=>child.once('close',()=>{closed=true;for(const waiter of pending.values())waiter.reject(new Error('Codex app-server exited'));resolve();}));
  child.stdout!.on('data',data=>{
    buffer+=String(data);
    for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      let value:any;try{value=JSON.parse(line);}catch{continue;}
      messages.push(value);if(messages.length>4096)messages.shift();
      if(typeof value.id==='number'){pending.get(value.id)?.resolve(value);pending.delete(value.id);}
    }
  });
  const send=(value:any)=>child.stdin!.write(JSON.stringify(value)+'\n');
  const rpc=(id:number,method:string,params:any)=>new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out`));},30000);
    pending.set(id,{resolve(value){clearTimeout(timer);resolve(value);},reject(error){clearTimeout(timer);reject(error);}});
    send({id,method,params});
  });
  const turn=async(id:number,threadId:string,prompt:string)=>{
    const start=messages.length,result=await rpc(id,'turn/start',{threadId,input:[{type:'text',text:prompt}]});
    if(result.error)throw new Error('turn/start rejected');
    const deadline=Date.now()+180000;
    while(!closed && Date.now()<deadline){
      const terminal=messages.slice(start).find(m=>m.method==='turn/completed');
      if(terminal)return {status:terminal.params?.turn?.status,text:messages.slice(start).filter(m=>m.method==='item/completed' && m.params?.item?.type==='agentMessage').map(m=>m.params.item.text).join('\n')};
      await Bun.sleep(50);
    }
    throw new Error('provider turn did not finish');
  };
  try{
    const init=await rpc(1,'initialize',{clientInfo:{name:'bungee_real_provider_probe',version:'1.0'},capabilities:{experimentalApi:true}});
    if(init.error)throw new Error('initialize rejected');send({method:'initialized'});
    const catalog=await rpc(2,'model/list',{includeHidden:false});
    const thread=await rpc(3,'thread/start',{model:input.model,cwd:root,approvalPolicy:'never',sandbox:'workspace-write',ephemeral:true,experimentalRawEvents:false});
    if(!thread.result?.thread?.id)throw new Error('thread/start rejected');
    const first=await turn(4,thread.result.thread.id,`Acceptance ${nonce}. Work only in ${root}. Use the local exec_command shell tool to read ${path}. Use apply_patch or the local shell to replace only its second line ${before} with ${after}, keeping the other lines unchanged. Read ${path} again using exec_command to verify it. Call the local codex_fixture MCP echo with fixture_echo=${mcp}. Do not inspect other directories. Finish after these operations.`);
    const second=await turn(5,thread.result.thread.id,'Continue from the preceding turn without calling any tools: give the exact current second line of probe.txt and the exact MCP echo result from that turn.');
    const actual=await readFile(path,'utf8');
    const mcpCalls=(await readFile(audit,'utf8').catch(()=> '')).split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(e=>e.event==='tools/call');
    const items=messages.filter(m=>m.method==='item/completed').map(m=>m.params?.item).filter(Boolean);
    return {root,nonce,model:input.model,listed:(catalog.result?.data??[]).some((m:any)=>m.model===input.model),
      firstStatus:first.status,continuationStatus:second.status,fileExact:actual===expected,
      mcpExact:mcpCalls.some(e=>e.text===mcp),continuationExact:second.text.includes(after)&&second.text.includes(mcp),
      commandCount:items.filter(i=>i.type==='commandExecution').length,fileChangeCount:items.filter(i=>i.type==='fileChange').length,
      mcpCallCount:items.filter(i=>i.type==='mcpToolCall').length};
  }finally{
    child.stdin!.end();
    await Promise.race([exit,Bun.sleep(5000)]);
    if(!closed){child.kill('SIGTERM');await Promise.race([exit,Bun.sleep(5000)]);}
    if(!closed){child.kill('SIGKILL');await exit;}
  }
}

if(import.meta.main){
  if(process.env.BUNGEE_REAL_CODEX_PROBE!=='1')throw new Error('Set BUNGEE_REAL_CODEX_PROBE=1 only for explicitly authorized live acceptance');
  const [model,baseUrl]=process.argv.slice(2);if(!model||!baseUrl)throw new Error('Expected model and existing Bungee base URL');
  const report=await probeCodexProvider({model,baseUrl});console.log(JSON.stringify(report));
  if(!(report.firstStatus==='completed'&&report.continuationStatus==='completed'&&report.fileExact&&report.mcpExact&&report.continuationExact))process.exitCode=1;
}
