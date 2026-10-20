import {expect,test} from 'bun:test';
import {collectRecoveryAnswers, readRecoveryAnswers} from '../../src/master-runtime/recovery-prompt';
import {withRecoveryTerminal} from '../../../../tests/helpers/recovery-terminal';

test.each(['\u001b[A', '\u001b[B', '\u001b[A\u001b[B\u001b[A'])('real readline never recalls hidden answers at public prompts (%j)', async keys => {
  const password = 'synthetic-password-never-printed', confirmation = 'synthetic-confirmation-never-printed';
  const prompts = [
    {name: 'username', label: 'Account', secret: false},
    {name: 'password', label: 'Password', secret: true},
    {name: 'confirmation', label: 'Confirmation', secret: true},
    {name: 'reason', label: 'Reason', secret: false},
  ];
  const {result, output} = await withRecoveryTerminal(() => readRecoveryAnswers(prompts), [
    {label: 'Account', answer: 'operator'}, {label: 'Password', answer: keys + password},
    {label: 'Confirmation', answer: keys + confirmation}, {label: 'Reason', answer: keys + 'Verified recovery'},
  ]);
  expect(result).toEqual({username: 'operator', password, confirmation, reason: 'Verified recovery'});
  expect(output).not.toContain(password); expect(output).not.toContain(confirmation);
});

for (const field of ['password', 'confirmation']) {
  test.each(['\u0015', '\u0001\u000b'])(`real readline isolates ${field} kill/yank editing from later public input (%j)`, async erase => {
    const password = 'synthetic-password-never-printed', confirmation = 'synthetic-confirmation-never-printed', deleted = 'synthetic-deleted-secret-never-printed';
    const prompts = [
      {name:'password',label:'Password',secret:true}, {name:'confirmation',label:'Confirmation',secret:true},
      {name:'reason',label:'Reason',secret:false},
    ];
    const edit = (name:string, answer:string) => (field === name ? deleted + erase : '') + answer;
    const {result,output,inputState}=await withRecoveryTerminal(()=>readRecoveryAnswers(prompts),[
      {label:'Password',answer:edit('password',password)}, {label:'Confirmation',answer:edit('confirmation',confirmation)},
      {label:'Reason',answer:'\u0019Verified recovery\u0019'},
    ]);
    expect(result).toEqual({password,confirmation,reason:'Verified recovery'});
    for(const secret of [password,confirmation,deleted]) expect(output).not.toContain(secret);
    expect(inputState).toEqual({isRaw:false,dataListeners:0,endListeners:0,closeListeners:0,keypressListeners:0});
  });
}

test.each(['\u0003','\u0004'])('real readline cancels on SIGINT or EOF and cleans up (%j)',async key=>{
  const {result,output,inputState}=await withRecoveryTerminal(()=>readRecoveryAnswers([
    {name:'password',label:'Password',secret:true}, {name:'reason',label:'Reason',secret:false},
  ]).catch(error=>error),[{label:'Password',answer:key}]);
  expect(result).toBeInstanceOf(Error);expect(result.message).toBe('recovery_cancelled');
  expect(output).not.toContain('Reason');
  expect(inputState).toEqual({isRaw:false,dataListeners:0,endListeners:0,closeListeners:0,keypressListeners:0});
});

test.each(['end','close'] as const)('real input stream %s cancels the current prompt and releases listeners',async inputEvent=>{
  const {result,output,inputState}=await withRecoveryTerminal(()=>readRecoveryAnswers([
    {name:'password',label:'Password',secret:true}, {name:'reason',label:'Reason',secret:false},
  ]).catch(error=>error),[{label:'Password',answer:'',inputEvent}]);
  expect(result).toBeInstanceOf(Error);expect(result.message).toBe('recovery_cancelled');
  expect(output).not.toContain('Reason');
  expect(inputState.dataListeners).toBe(0);expect(inputState.endListeners).toBe(0);expect(inputState.closeListeners).toBe(0);expect(inputState.keypressListeners).toBe(0);
});

test('successful questions preserve the original raw mode and an unrelated input listener',async()=>{
  const {result,inputState}=await withRecoveryTerminal(async()=>{
    const input=process.stdin,observer=()=>{};
    input.on('data',observer);
    try{
      const result=await readRecoveryAnswers([{name:'credential',label:'Credential',secret:true}]);
      expect(input.listeners('data')).toContain(observer);expect(input.readableFlowing).toBe(true);expect(input.destroyed).toBe(false);
      return result;
    }finally{input.off('data',observer);}
  },[{label:'Credential',answer:'synthetic secret'}],true);
  expect(result).toEqual({credential:'synthetic secret'});
  expect(inputState).toEqual({isRaw:true,dataListeners:0,endListeners:0,closeListeners:0,keypressListeners:0});
});

test('raw mode is restored and byte limit includes edited-away secrets across questions',async()=>{
  const {result,inputState}=await withRecoveryTerminal(()=>readRecoveryAnswers([
    {name:'password',label:'Password',secret:true}, {name:'confirmation',label:'Confirmation',secret:true},
    {name:'reason',label:'Reason',secret:false},
  ]).catch(error=>error),[
    {label:'Password',answer:'a'.repeat(4000)+'\u0015accepted password'},
    {label:'Confirmation',answer:'b'.repeat(4000)+'\u0001\u000baccepted password'},
    {label:'Reason',answer:'r'.repeat(200)},
  ],true);
  expect(result).toBeInstanceOf(Error);expect(result.message).toBe('recovery_input_too_large');
  expect(inputState).toEqual({isRaw:true,dataListeners:0,endListeners:0,closeListeners:0,keypressListeners:0});
});

test('generic prompts preserve plugin field names and secret flags without account rules', async () => {
  const hidden: boolean[] = [], replies = ['custom identifier', 'short', 'different', 'operator supplied reason'];
  const prompts = [
    {name: 'principal', label: 'Principal', secret: false},
    {name: 'credential', label: 'Credential', secret: true},
    {name: 'confirmation', label: 'Confirmation', secret: true},
    {name: 'reason', label: 'Reason', secret: false},
  ];
  const input = await collectRecoveryAnswers(prompts, async (_label, secret) => { hidden.push(secret); return replies.shift()!; });
  expect(hidden).toEqual([false, true, true, false]);
  expect(input).toEqual({principal: 'custom identifier', credential: 'short', confirmation: 'different', reason: 'operator supplied reason'});
});

test('prompt protocol rejects reserved or duplicate fields before asking and bounds answers', async () => {
  let asked = false;
  const ask = async () => {asked = true; return '';};
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    await expect(collectRecoveryAnswers([{name, label: 'Prompt', secret: false}], ask)).rejects.toThrow('invalid_recovery_prompts');
  }
  await expect(collectRecoveryAnswers([{name: 'a', label: 'A', secret: false}, {name: 'a', label: 'A', secret: true}], ask)).rejects.toThrow('invalid_recovery_prompts');
  expect(asked).toBe(false);
  await expect(collectRecoveryAnswers([{name: 'credential', label: 'Credential', secret: true}], async () => 'x'.repeat(8192))).rejects.toThrow('too_large');
});


test('answer budget applies to the declared fields without a host business envelope',async()=>{
 const credential='x'.repeat(8175);
 expect(await collectRecoveryAnswers([{name:'credential',label:'Credential',secret:true}],async()=>credential)).toEqual({credential});
 await expect(collectRecoveryAnswers([{name:'credential',label:'Credential',secret:true}],async()=>credential+'x')).rejects.toThrow('too_large');
});


test('plugins may name an action field operation without a host-injected value',async()=>{
 expect(await collectRecoveryAnswers([{name:'operation',label:'Operation',secret:false}],async()=>'plugin-choice')).toEqual({operation:'plugin-choice'});
});


test('an action may declare no input fields',async()=>{
 let asked=false;
 expect(await collectRecoveryAnswers([],async()=>{asked=true;return '';})).toEqual({});
 expect(asked).toBe(false);
});
