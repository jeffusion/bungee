import * as path from 'path';

export interface PluginSearchPathOptions {
  category?: string;
  includeServerEntry?: boolean;
}

export class PluginPathResolver {
  private readonly systemPluginsDir: string;
  private readonly customPluginsDir: string;

  constructor(baseDir: string, configBasePath: string) {
    const isDevMode = baseDir.endsWith('/src') || baseDir.endsWith('\\src');
    this.systemPluginsDir = isDevMode
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
      path.join(this.systemPluginsDir, `${subPath}.js`),
      path.join(this.systemPluginsDir, `${subPath}.ts`),
      path.join(this.systemPluginsDir, subPath, 'index.js'),
      path.join(this.systemPluginsDir, subPath, 'index.ts'),
    );

    return paths;
  }

  getScanDirectories(): string[] {
    return [this.customPluginsDir, this.systemPluginsDir];
  }
}
