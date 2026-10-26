import { arch, platform } from 'node:os';

export type BinaryName =
  | 'bungee-linux'
  | 'bungee-linux-arm64'
  | 'bungee-macos'
  | 'bungee-macos-arm64'
  | 'bungee-windows.exe';

const ASSET_NAMES: Readonly<Record<BinaryName, string>> = {
  'bungee-linux': 'bungee-linux.tar.gz',
  'bungee-linux-arm64': 'bungee-linux-arm64.tar.gz',
  'bungee-macos': 'bungee-macos.tar.gz',
  'bungee-macos-arm64': 'bungee-macos-arm64.tar.gz',
  'bungee-windows.exe': 'bungee-windows.exe.tar.gz',
};

export function getBinaryName(
  platformName: NodeJS.Platform = platform(),
  architecture: string = arch(),
): BinaryName {
  if (platformName === 'darwin' && architecture === 'arm64') return 'bungee-macos-arm64';
  if (platformName === 'darwin' && architecture === 'x64') return 'bungee-macos';
  if (platformName === 'linux' && architecture === 'arm64') return 'bungee-linux-arm64';
  if (platformName === 'linux' && architecture === 'x64') return 'bungee-linux';
  if (platformName === 'win32' && architecture === 'x64') return 'bungee-windows.exe';
  throw new Error(`Unsupported platform: ${platformName}-${architecture}`);
}

export function getAssetName(binaryName: BinaryName = getBinaryName()): string {
  return ASSET_NAMES[binaryName];
}
