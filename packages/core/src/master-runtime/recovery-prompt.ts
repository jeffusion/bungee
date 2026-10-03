import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';

export async function collectAdministratorRecovery(ask:(label:string,secret:boolean)=>Promise<string>) {
  const newUsername=(await ask('新的管理员账号：',false)).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/.test(newUsername)) throw new Error('invalid_recovery_username');
  const password=await ask('新密码（6–64 个字符，输入不显示）：',true);
  const confirmation=await ask('确认新密码：',true);
  if ([...password].length<6 || [...password].length>64 || password!==confirmation) throw new Error('invalid_recovery_password');
  return {kind:'identity',plugin:'local-accounts',payload:{newUsername,password,reason:'interactive administrator recovery'}};
}
/** Passwords stay off argv, terminal echo and shell history. */
export async function readAdministratorRecovery() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('recovery_requires_terminal');
  console.log('请先停止目标实例的全部进程，并确认数据库路径及部署环境。恢复后旧会话全部失效。');
  let hidden=false;
  const output=new Writable({write(chunk,_encoding,callback){if(!hidden)process.stdout.write(chunk);callback();}});
  const rl=createInterface({input:process.stdin,output,terminal:true});
  try {
    return await collectAdministratorRecovery(async(label,secret)=>{
      const pending=rl.question(label);hidden=secret;
      try{return await pending;}finally{hidden=false;if(secret)process.stdout.write('\n');}
    });
  }finally{rl.close();output.end();}
}
