import {expect,test} from 'bun:test';
import {protocolRequestPath} from '../../src/plugin-api';

test('generation endpoints preserve the Responses entry and Gemini stream method',()=>{
  for(const streaming of [false,true]){
    expect(protocolRequestPath('responses','m',streaming)).toBe('/responses');
    expect(protocolRequestPath('chat_completions','m',streaming)).toBe('/v1/chat/completions');
    expect(protocolRequestPath('anthropic_messages','m',streaming)).toBe('/v1/messages');
  }
  expect(protocolRequestPath('gemini_generate_content','gemini-2.5-flash',false)).toBe('/v1beta/models/gemini-2.5-flash:generateContent');
  expect(protocolRequestPath('gemini_generate_content','gemini-2.5-flash',true)).toBe('/v1beta/models/gemini-2.5-flash:streamGenerateContent');
  expect(protocolRequestPath('gemini_generate_content','model/segment',false)).toBe('/v1beta/models/model%2Fsegment:generateContent');
});
test('unknown protocols and missing Gemini model reject before generating a path',()=>{
  expect(()=>protocolRequestPath('unknown' as any,'m',false)).toThrow('Unknown protocol');
  expect(()=>protocolRequestPath('gemini_generate_content','',false)).toThrow('Target model is required');
});
