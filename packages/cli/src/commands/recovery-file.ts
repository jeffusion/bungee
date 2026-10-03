import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { assertWindowsOwnerOnlyFileAcl, type WindowsAclAdapter } from '@jeffusion/bungee-types/daemon-file';

const UNSAFE_INPUT = 'Recovery input must be an owner-only regular file of at most 8192 bytes';

/** Keep the verified descriptor open so the child reads the same file through stdin. */
export async function openRecoveryInputFile(path: string, options: {platform?: NodeJS.Platform; windowsAcl?: WindowsAclAdapter} = {}): Promise<Awaited<ReturnType<typeof open>>> {
  const platform = options.platform ?? process.platform;
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error(UNSAFE_INPUT);
  const file = await open(path, constants.O_RDONLY | (platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 8192) throw new Error(UNSAFE_INPUT);
    if (platform === 'win32') await assertWindowsOwnerOnlyFileAcl(path, options.windowsAcl);
    else if ((opened.mode & 0o777) !== 0o600 || (process.getuid && opened.uid !== process.getuid())) throw new Error(UNSAFE_INPUT);
    // ACL checks address a path; reject a replacement instead of passing its old descriptor.
    const after = await lstat(path);
    const final = await file.stat();
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.dev !== opened.dev || after.ino !== opened.ino
      || final.nlink !== 1 || final.size > 8192 || final.size !== opened.size
      || (platform !== 'win32' && ((final.mode & 0o777) !== 0o600 || (process.getuid && final.uid !== process.getuid())))) throw new Error(UNSAFE_INPUT);
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
