import { resolve, join } from 'node:path';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { ConfigPaths } from '../config/paths';
import { resolveCoreLaunchDescriptor, type LaunchDescriptor } from '../daemon/manager';

/** JSON input is stdin or an owner-only regular file; never credentials in argv/env. */
export async function recoverCommand(options: {file?:string; directLaunch?:LaunchDescriptor; launchDescriptor?:LaunchDescriptor} = {}): Promise<void> {
  const launch = await resolveCoreLaunchDescriptor(options);
  const db = resolve(process.env.BUNGEE_CONFIG_DB_PATH ?? join(ConfigPaths.DATA_DIR,'bungee.db'));
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (options.file) {
      file = await open(options.file,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()) || stat.size > 8192) throw new Error('Recovery input must be an owner-only 0600 regular file of at most 8192 bytes');
    }
    await new Promise<void>((accept,reject) => {
      const child = spawn(launch.executable,[...(launch.entrypoint === null ? [] : [launch.entrypoint]),'--recover',db],{cwd:ConfigPaths.DATA_DIR,stdio:[file?.fd ?? 'inherit','inherit','inherit'],env:{...process.env,BUNGEE_ROLE:'master'}});
      child.once('error',reject);
      child.once('exit',code=>code===0?accept():reject(new Error('Offline recovery failed')));
    });
  } finally { await file?.close(); }
}
