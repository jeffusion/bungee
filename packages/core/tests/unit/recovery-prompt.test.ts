import {expect,test} from 'bun:test';
import {collectAdministratorRecovery} from '../../src/master-runtime/recovery-prompt';
test('interactive recovery hides both password prompts and never needs the old account name',async()=>{
 const hidden:boolean[]=[];const replies=['restored','123456','123456'];
 const input=await collectAdministratorRecovery(async(_label,secret)=>{hidden.push(secret);return replies.shift()!;});
 expect(hidden).toEqual([false,true,true]);expect(input.payload).toMatchObject({newUsername:'restored',password:'123456'});expect(input.payload).not.toHaveProperty('username');
 const wrong=['restored','123456','654321'];await expect(collectAdministratorRecovery(async()=>wrong.shift()!)).rejects.toThrow('invalid_recovery_password');
});
