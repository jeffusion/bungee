import { resolve, join, dirname } from 'node:path';
import { open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { ConfigPaths } from '../config/paths';
import { resolveCoreLaunchDescriptor, type LaunchDescriptor } from '../daemon/manager';
import { openRecoveryInputFile } from './recovery-file';
import { readPluginSecretsKey, withPluginSecretsKey } from '../config/plugin-secrets-key';

/** JSON input is stdin or an owner-only regular file; never credentials in argv/env. */
export async function recoverCommand(options: {file?:string; plugin?:string; action?:string; directLaunch?:LaunchDescriptor; launchDescriptor?:LaunchDescriptor} = {}): Promise<void> {
  const interactive = options.plugin !== undefined || options.action !== undefined;
  if (interactive && (options.file !== undefined || !options.plugin || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(options.plugin)
    || !['issue-setup-code', 'reset', 'release-auth'].includes(options.action ?? ''))) throw new Error('invalid_recovery_arguments');
  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('recovery_requires_terminal');
  const db = resolve(process.env.BUNGEE_CONFIG_DB_PATH ?? join(ConfigPaths.DATA_DIR,'bungee.db'));
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (options.file) {
      file = await openRecoveryInputFile(options.file);
    }
    const key = await readPluginSecretsKey(db);
    const launch = await resolveCoreLaunchDescriptor(options);
    await new Promise<void>((accept,reject) => {
      const args = [...(launch.entrypoint === null ? [] : [launch.entrypoint]), '--recover', db,
        ...(interactive ? ['--plugin', options.plugin!, '--action', options.action!] : [])];
      const child = spawn(launch.executable,args,{cwd:dirname(db),stdio:[file?.fd ?? 'inherit','inherit','inherit'],env:{...withPluginSecretsKey(process.env,key),BUNGEE_ROLE:'master',BUNGEE_ACCESS_DB_PATH:process.env.BUNGEE_ACCESS_DB_PATH??join(ConfigPaths.LOGS_DIR,'access.db')}});
      child.once('error',reject);
      child.once('exit',code=>code===0?accept():reject(new Error('Offline recovery failed')));
    });
  } finally { await file?.close(); }
}
