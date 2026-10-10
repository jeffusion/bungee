import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ChatgptOauthPlugin from '../../server';
import { createPluginHooks } from '../../../../packages/core/src/hooks';
import { credentialPolicyFromManifest, assertCredentialTarget, applyOutboundHeaderProfile } from '../../../../packages/core/src/worker/request/credential';

test('OAuth WS handshake maps only Responses, and the GET credential profile preserves Codex headers',async()=>{
  const hooks=createPluginHooks();new ChatgptOauthPlugin().register(hooks);
  const original={connectionId:'conn',routeId:'/v1',upstreamId:'up',url:new URL('https://chatgpt.com/v1/responses?test=1'),headers:new Headers({'OpenAI-Beta':'responses_websockets=2026-02-06','Session-Id':'session','Authorization':'client-secret'}),signal:new AbortController().signal};
  const handshake=await hooks.onWebSocketHandshake.promise(original);
  expect(handshake.url.pathname).toBe('/backend-api/codex/responses');expect(handshake.url.search).toBe('?test=1');
  const manifest=JSON.parse(readFileSync(new URL('../../manifest.json',import.meta.url),'utf8'));
  const policy=credentialPolicyFromManifest(manifest,'chatgpt');
  const profile=assertCredentialTarget(handshake.url,new URL('https://chatgpt.com'),policy,'GET').outboundHeaders!;
  const headers=applyOutboundHeaderProfile(handshake.headers,profile);
  expect(headers.get('openai-beta')).toBe('responses_websockets=2026-02-06');expect(headers.get('session-id')).toBe('session');
  expect(headers.has('authorization')).toBe(false);expect(headers.has('content-type')).toBe(false);expect(headers.get('accept')).toBeNull();
  expect(headers.get('originator')).toBe('codex-tui');
  expect(()=>assertCredentialTarget(new URL('https://evil.example/backend-api/codex/responses'),new URL('https://chatgpt.com'),policy,'GET')).toThrow();
  expect(()=>assertCredentialTarget(new URL('https://chatgpt.com/v1/chat/completions'),new URL('https://chatgpt.com'),policy,'GET')).toThrow();
  const siwc={...handshake,url:new URL('https://api.openai.com/v1/responses')};
  expect((await hooks.onWebSocketHandshake.promise(siwc)).url.pathname).toBe('/v1/responses');
  expect(assertCredentialTarget(siwc.url,new URL('https://api.openai.com'),credentialPolicyFromManifest(manifest,'chatgpt-siwc'),'GET').outboundHeaders!.set['Content-Type']).toBeUndefined();
});
