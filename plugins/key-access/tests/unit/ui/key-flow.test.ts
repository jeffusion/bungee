import { expect, test } from 'bun:test';
import { ApiError } from '../../../../../packages/ui/src/api/client';
import { createdCredential, publicationMessage, keyApplied } from '../../../ui/key-flow';

test('a persisted credential is recovered only from an error that contains its actual key and token', () => {
  const key={id:'k',name:'saved',prefix:'bk_fixture',createdAt:1,expiresAt:null,revokedAt:null};
  expect(createdCredential(new ApiError(503,{key,token:'saved-token',persisted:true},'pending'))).toMatchObject({key,token:'saved-token'});
  for(const error of [new Error('offline'),new ApiError(503,{error:'unavailable'},'unavailable'),new ApiError(503,{key,token:null},'pending')]) expect(createdCredential(error)).toBeNull();
});
test('pending publication cannot be presented as complete', () => {
  expect(publicationMessage({ready:false,published:false})).toBe('ui.publicationPending');
  expect(publicationMessage({ready:true,published:false})).toBe('ui.publicationPending');
  expect(publicationMessage({ready:true,published:true})).toBe('ui.publicationComplete');
});
test('unrestricted and explicit grants apply independently of route protection', () => {
  const bindings={public:[{id:'explicit'}]};
  expect(keyApplied('unlisted-public','any',['any'],bindings)).toBe(true);
  expect(keyApplied('public','explicit',['any'],bindings)).toBe(true);
  expect(keyApplied('unlisted-public','explicit',['any'],bindings)).toBe(false);
});
