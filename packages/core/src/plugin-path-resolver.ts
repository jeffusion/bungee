import * as path from 'path';

export interface PluginSearchPathOptions {
  category?: string;
  includeServerEntry?: boolean;
}

export interface PluginScanRoot {
  path: string;
  required: boolean;
}

export class PluginPathResolver {
  private readonly systemPluginsDir: string;
  private readonly customPluginsDir: string;
  private readonly includeSystemPlugins: boolean;

  constructor(baseDir: string, configBasePath: string, executablePath = process.execPath) {
    const isDevMode = baseDir.endsWith('/src') || baseDir.endsWith('\\src');
    const isCompiled = baseDir.startsWith('/$bunfs/') || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(baseDir);
    const includeSystemPluginsEnv = process.env.BUNGEE_INCLUDE_SYSTEM_PLUGINS;
    this.includeSystemPlugins = includeSystemPluginsEnv === 'true'
      || (!isDevMode && includeSystemPluginsEnv !== 'false');

    this.systemPluginsDir = isCompiled
      ? path.join(path.dirname(executablePath), 'plugins')
      : isDevMode
        ? path.join(baseDir, '..', 'dist', 'plugins')
        : path.join(baseDir, 'plugins');

    const pluginsDirEnv = process.env.PLUGINS_DIR || './plugins';
    this.customPluginsDir = path.isAbsolute(pluginsDirEnv)
      ? pluginsDirEnv
      : path.resolve(configBasePath, pluginsDirEnv);
  }

  getSearchPaths(pluginName: string, options: PluginSearchPathOptions = {}): string[] {
    const paths: string[] = [];
    const subPath = options.category ? path.join(options.category, pluginName) : pluginName;

    if (options.includeServerEntry) {
      paths.push(
        path.join(this.customPluginsDir, subPath, 'server', 'index.ts'),
        path.join(this.customPluginsDir, subPath, 'server', 'index.js'),
      );
    }

    paths.push(
      path.join(this.customPluginsDir, `${subPath}.ts`),
      path.join(this.customPluginsDir, `${subPath}.js`),
      path.join(this.customPluginsDir, subPath, 'index.ts'),
      path.join(this.customPluginsDir, subPath, 'index.js'),
    );

    if (this.includeSystemPlugins) {
      paths.push(
        path.join(this.systemPluginsDir, `${subPath}.js`),
        path.join(this.systemPluginsDir, `${subPath}.ts`),
        path.join(this.systemPluginsDir, subPath, 'index.js'),
        path.join(this.systemPluginsDir, subPath, 'index.ts'),
      );
    }

    return paths;
  }

  getScanDirectories(): string[] {
    return this.includeSystemPlugins
      ? [this.customPluginsDir, this.systemPluginsDir]
      : [this.customPluginsDir];
  }

  getScanRoots(): PluginScanRoot[] {
    if (!this.includeSystemPlugins) return [{ path: this.customPluginsDir, required: true }];
    return [
      { path: this.customPluginsDir, required: false },
      { path: this.systemPluginsDir, required: true },
    ];
  }
}
