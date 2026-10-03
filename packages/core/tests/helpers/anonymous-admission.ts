import {DataAdmissionHost} from '../../src/data-admission/host';
import {createDataAdmissionRpcServer, createSignedWorkerRpcClient, DATA_ADMISSION_RPC_PATH} from '../../src/data-admission/rpc';
import {setWorkerAdmissionSession} from '../../src/data-admission/worker';
import {TEST_WORKER_TRANSPORT_SECRET} from '../fixtures/config-worker-private-transport';

/** Real anonymous admission for integration tests using signed ingress transport. */
export async function startAnonymousAdmission() {
  const worker = {role:'worker' as const,master_generation:crypto.randomUUID(),process_instance_id:crypto.randomUUID(),boot_nonce:crypto.randomUUID(),worker_slot:0};
  const identity = {role:'ingress' as const,process_instance_id:crypto.randomUUID(),boot_nonce:crypto.randomUUID()};
  const host = new DataAdmissionHost({authorizeWorker:()=> 'active',catalogHash:()=> 'test-catalog'});
  await host.publish({version:1,plugins:[]});
  const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:createDataAdmissionRpcServer({host,transportSecret:TEST_WORKER_TRANSPORT_SECRET,identity,authorizeWorker:()=> 'active'})});
  setWorkerAdmissionSession({admission:createSignedWorkerRpcClient({transportSecret:TEST_WORKER_TRANSPORT_SECRET,worker,expectedServer:identity,url:`http://127.0.0.1:${server.port}${DATA_ADMISSION_RPC_PATH}`})});
  return async () => {setWorkerAdmissionSession(null);await server.stop(true);};
}
