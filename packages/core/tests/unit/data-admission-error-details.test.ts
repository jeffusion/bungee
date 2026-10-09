import {expect,test} from 'bun:test';
import {DataAdmissionError,normalizeAdmissionError} from '../../src/data-admission/errors';

test('safe admission details survive a separately bundled error identity',()=>{
  const foreign=Object.assign(new Error('do not expose this outer message'),{name:'DataAdmissionError',status:422,code:'codex_router_unsupported_request',
    details:{message:'Unrecognized request option',param:'stream_options.future'}});
  const normalized=normalizeAdmissionError(foreign)!;
  expect(normalized).toBeInstanceOf(DataAdmissionError);
  expect(normalized.details).toEqual({message:'Unrecognized request option',param:'stream_options.future'});
  expect(normalized.message).toBe('codex_router_unsupported_request');
  expect(Object.isFrozen(normalized.details)).toBe(true);
});
test('admission details reject excessive messages, control characters and invalid parameter paths',()=>{
  for(const details of [{message:'x'.repeat(513),param:'x'.repeat(257)}, {message:'bad\nmessage',param:'bad\npath'}, {message:42,param:'"value"'}]) {
    expect(new DataAdmissionError(422,'invalid',undefined,details as any).details).toBeUndefined();
  }
  expect(new DataAdmissionError(422,'invalid',undefined,{message:'safe',param:'input[3].tools[0]'}).details).toEqual({message:'safe',param:'input[3].tools[0]'});
});
test('details do not relax status, code or retry validation',()=>{
  for(const value of [{status:200},{code:'unsafe code'},{retryAfter:-1}]) {
    expect(normalizeAdmissionError(Object.assign(new Error(),{name:'DataAdmissionError',status:422,code:'invalid',details:{message:'safe'},...value}))).toBeNull();
  }
});
