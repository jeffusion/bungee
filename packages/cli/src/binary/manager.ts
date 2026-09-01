import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import pkg from '../../package.json';
import { installBinaryArchive } from './archive-installer';
import { getAssetName, getBinaryName, type BinaryName } from './names';

type DownloadOptions = {
  readonly force?: boolean;
  readonly silent?: boolean;
  readonly assetUrl?: string;
};

type EnsureOptions = {
  readonly force?: boolean;
  readonly autoUpgrade?: boolean;
};

export class BinaryManager {
  private static readonly BINARY_DIR = join(homedir(), '.bungee', 'bin');
  private static readonly VERSION_FILE = join(homedir(), '.bungee', 'version.txt');
  private static readonly GITHUB_REPO = 'jeffusion/bungee';

  static getBinaryName(): BinaryName {
    return getBinaryName();
  }

  static getAssetName(): string {
    return getAssetName(this.getBinaryName());
  }

  static getLocalBinaryPath(): string {
    return join(this.BINARY_DIR, pkg.version, this.getBinaryName());
  }

  static isBinaryInstalled(): boolean {
    return existsSync(this.getLocalBinaryPath());
  }

  static getInstalledVersion(): string | null {
    try {
      return existsSync(this.VERSION_FILE) ? readFileSync(this.VERSION_FILE, 'utf8').trim() : null;
    } catch {
      return null;
    }
  }

  private static saveVersion(version: string): void {
    mkdirSync(join(homedir(), '.bungee'), { recursive: true });
    writeFileSync(this.VERSION_FILE, version);
  }

  static checkVersion(): boolean {
    return this.getInstalledVersion() === pkg.version && this.isBinaryInstalled();
  }

  private static getDownloadUrl(): string {
    return `https://github.com/${this.GITHUB_REPO}/releases/download/v${pkg.version}/${this.getAssetName()}`;
  }

  private static async promptConfirm(message: string): Promise<boolean> {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      prompt.question(`${message} (y/N): `, (answer) => {
        prompt.close();
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });
  }

  static async downloadBinary(options: DownloadOptions = {}): Promise<void> {
    const url = options.assetUrl ?? this.getDownloadUrl();
    mkdirSync(this.BINARY_DIR, { recursive: true });
    const archivePath = join(this.BINARY_DIR, `.download-${randomUUID()}.tar.gz`);
    if (!options.silent) {
      console.log(`Downloading Bungee v${pkg.version} from ${url}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) {
        throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
      }
      writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
      const executable = installBinaryArchive({
        archivePath,
        installRoot: this.BINARY_DIR,
        version: pkg.version,
        binaryName: this.getBinaryName(),
      });
      this.saveVersion(pkg.version);
      if (!options.silent) console.log(`Installed Bungee at ${executable}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to install binary archive: ${detail}`, { cause: error });
    } finally {
      rmSync(archivePath, { force: true });
    }
  }

  static async ensureBinary(options: EnsureOptions = {}): Promise<string> {
    if (this.checkVersion()) return this.getLocalBinaryPath();
    if (this.isBinaryInstalled() && !options.autoUpgrade && !options.force) {
      const confirmed = await this.promptConfirm('Installed binary version differs. Upgrade now?');
      if (!confirmed) return this.getLocalBinaryPath();
    } else if (!this.isBinaryInstalled() && !options.force) {
      const confirmed = await this.promptConfirm('Bungee binary is not installed. Download now?');
      if (!confirmed) throw new Error('Binary download cancelled by user');
    }
    await this.downloadBinary({ force: options.force });
    return this.getLocalBinaryPath();
  }

  static async upgrade(options: Readonly<{ force?: boolean }> = {}): Promise<void> {
    if (this.checkVersion() && !options.force) {
      console.log(`Bungee v${pkg.version} is already installed`);
      return;
    }
    await this.downloadBinary({ force: true });
  }

  static getBinaryInfo(): {
    readonly binaryName: string;
    readonly assetName: string;
    readonly localPath: string;
    readonly installed: boolean;
    readonly installedVersion: string | null;
    readonly requiredVersion: string;
    readonly versionMatches: boolean;
  } {
    return {
      binaryName: this.getBinaryName(),
      assetName: this.getAssetName(),
      localPath: this.getLocalBinaryPath(),
      installed: this.isBinaryInstalled(),
      installedVersion: this.getInstalledVersion(),
      requiredVersion: pkg.version,
      versionMatches: this.checkVersion(),
    };
  }
}
