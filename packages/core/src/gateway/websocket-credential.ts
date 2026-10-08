import type { RuntimeUpstream } from '../worker/types';
import type { PluginConfigOptions } from '@jeffusion/bungee-types';
import { getPluginRegistry } from '../worker/state/plugin-manager';
import { getBoundControlClient } from '../config-worker/runtime-dependencies';
import { credentialPolicyFromManifest, assertCredentialTarget, stripCredentialHeaders, applyOutboundHeaderProfile, validateCredentialLease } from '../worker/request/credential';

/** Uses the same exact endpoint/binding/origin credential policy as HTTP attempts. */
export async function websocketCredential(upstream: RuntimeUpstream, url: URL, sourceHeaders: Headers,
  revision: number, attemptId: string, signal: AbortSignal): Promise<Headers> {
  const endpoint=upstream as RuntimeUpstream & {managedBy?:{plugin:string;contributionId:string;bindingId:string}};
  const marker = endpoint.managedBy;
  if (!marker) return sourceHeaders;
  if (![marker.plugin,marker.contributionId,marker.bindingId].every(value=>typeof value==='string' && value.length>0)) throw new Error('invalid managed binding');
  const snapshot = getPluginRegistry()?.getPluginStateSnapshot(marker.plugin);
  const control = snapshot?.manifest?.control;
  const binding = upstream.plugins?.find(item=>typeof item!=='string' && item.name===marker.plugin && item.id===marker.bindingId && item.enabled===true);
  if (!snapshot?.manifest || snapshot.persistedEnabled==='disabled' || !control || !binding || typeof binding==='string' || !upstream.id) throw new Error('managed binding unavailable');
  const policy = credentialPolicyFromManifest(snapshot.manifest,marker.contributionId);
  const source = new URL(upstream.target);
  const expected = url.href;
  const profile = assertCredentialTarget(url,source,policy,'GET',url.pathname);
  stripCredentialHeaders(sourceHeaders,policy);
  // WS subprotocol negotiation belongs to the transport, independent of fixed credential headers.
  const headers = profile.outboundHeaders ? applyOutboundHeaderProfile(sourceHeaders,profile.outboundHeaders) : sourceHeaders;
  const credentialMethod = control.rpc.find(entry=>entry.name==='getCredential');
  if (!credentialMethod) throw new Error('credential method unavailable');
  const client = getBoundControlClient({plugin:marker.plugin,contributionId:marker.contributionId,bindingId:marker.bindingId,
    bindingOptions:(binding.options ?? {}) as PluginConfigOptions},{revision,endpointId:upstream.id,attemptId});
  const lease = validateCredentialLease(await client.call(credentialMethod.name,{},signal));
  if (signal.aborted || url.href!==expected) throw new Error('credential target changed');
  assertCredentialTarget(url,source,policy,'GET',url.pathname);
  const allowed = new Set(policy.allowedHeaderNames.map(name=>name.toLowerCase()));
  let count = 0;
  for (const [name,value] of Object.entries(lease.headers)) if (allowed.has(name.toLowerCase())) {headers.set(name,value);count++;}
  if (!count) throw new Error('empty credential lease');
  return headers;
}
