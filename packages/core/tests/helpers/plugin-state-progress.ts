export function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(accept=>{resolve=accept;});
  return {promise,resolve};
}
export async function waitForState(check:()=>boolean,timeoutMs=2000):Promise<void> {
  const deadline=Date.now()+timeoutMs;
  while(!check()) {
    if(Date.now()>=deadline)throw new Error('plugin_state_test_wait_timeout');
    await new Promise(resolve=>setTimeout(resolve,5));
  }
}
