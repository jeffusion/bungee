/// <reference lib="webworker" />
import {auxiliaryCredentialIdentity} from '../../src/gateway/auxiliary-request';
const scope=globalThis as unknown as DedicatedWorkerGlobalScope;
scope.onmessage=event=>{
  const {headers,model,upstreamId,managedCredentials}=event.data;
  scope.postMessage(auxiliaryCredentialIdentity(new Headers(headers),model,upstreamId,managedCredentials));
};
