import { getAsset } from './assets';
import { handleAPIRequest } from '../api/router';
import { PluginRegistry } from '../plugin-registry';
import path from 'path';
import { file } from 'bun';
import { promises as fs } from 'fs';
import { getPermissionManager } from '../plugin-permissions';
import { getPluginRuntimeOrchestrator } from '../worker/state/plugin-manager';

// 单例引用（需要在 main.ts 中注入或通过其他方式获取）
// 这里假设通过 global 或某种注册机制获取
// 为简化，我们暂时不做依赖注入，而是假设在运行时能够获取 pluginRegistry
// TODO: 更好的依赖注入

export async function handleUIRequest(req: Request, pluginRegistry?: PluginRegistry): Promise<Response | null> {
  const url = new URL(req.url);

  // 只处理 /__ui 路径
  if (!url.pathname.startsWith('/__ui')) {
    return null;
  }

  // 移除 /__ui 前缀
  const requestPath = url.pathname.replace(/^\/__ui/, '');

  // 处理API请求
  if (requestPath.startsWith('/api')) {
    return await handleAPIRequest(req, requestPath);
  }

  // 处理 Plugin UI 静态资源
  // 格式: /plugins/:pluginName/assets/...
  if (requestPath.startsWith('/plugins/')) {
    const parts = requestPath.split('/');
    // parts[0] is empty, parts[1] is 'plugins', parts[2] is pluginName
    const pluginName = parts[2];
    const assetPath = parts.slice(3).join('/');

    if (pluginName && assetPath && pluginRegistry) {
      return await servePluginAsset(pluginRegistry, pluginName, assetPath);
    }
  }

  // 根路径或 /index.html
  if (requestPath === '' || requestPath === '/' || requestPath === '/index.html') {
    const html = getAsset('/');
    if (html) {
      return new Response(html, {
        headers: { 'Content-Type': 'text/html' }
      });
    }
  }

  // 静态资源（CSS/JS文件）
  const asset = getAsset(requestPath);
  if (asset) {
    const contentType = getContentType(requestPath);
    return new Response(asset, {
      headers: { 'Content-Type': contentType }
    });
  }

  // SPA路由支持：未匹配的路径返回index.html
  if (!requestPath.includes('.')) {
    const html = getAsset('/');
    if (html) {
      return new Response(html, {
        headers: { 'Content-Type': 'text/html' }
      });
    }
  }

  return new Response('Not Found', { status: 404 });
}

async function servePluginAsset(registry: PluginRegistry, pluginName: string, assetPath: string): Promise<Response> {
  try {
    // 1. 获取插件运行时状态 (Orchestrator-first)
    const orchestrator = getPluginRuntimeOrchestrator();
    const statusReport = orchestrator?.getStatusReport();
    const pluginStatus = statusReport?.plugins.find(p => p.pluginName === pluginName);

    const assetDescriptor = registry.getPluginAssetDescriptor(pluginName);

    if (!assetDescriptor) {
      return new Response('Plugin not found', { status: 404 });
    }

    const manifest = assetDescriptor.manifest;

    // 3. 运行时状态与模式联动约束
    // 只有声明了 sandbox-iframe 且具备 sandboxUiExtension capability 的插件才能通过此接口服务 UI 资源
    if (!manifest || manifest.uiExtensionMode !== 'sandbox-iframe') {
      return new Response('UI extension (sandbox-iframe) not enabled for this plugin', { status: 403 });
    }

    if (!manifest.capabilities?.includes('sandboxUiExtension')) {
      return new Response('Plugin missing required capability: sandboxUiExtension', { status: 403 });
    }

    // 检查运行时生命周期
    // disabled / quarantined / degraded / non-serving 插件不应提供资源
    if (pluginStatus) {
      const lifecycle = pluginStatus.state.lifecycle;
      if (lifecycle !== 'serving' && lifecycle !== 'loaded') {
        return new Response(`Plugin is in ${lifecycle} state and cannot serve UI assets`, { status: 403 });
      }
    } else {
      // 如果 orchestrator 中没有该插件，说明它未被加载到运行时
      return new Response('Plugin not active in runtime', { status: 403 });
    }

    // 优先使用 manifest 中的 pluginDir
    const pluginDir = assetDescriptor.pluginDir;

    // 使用新的安全路径验证函数
    const validation = await validatePluginAssetPath(pluginDir, assetPath);

    if (!validation.valid) {
      console.error(`Security: ${validation.error} - Plugin: ${pluginName}, Path: ${assetPath}`);
      return new Response(validation.error || 'Access denied', { status: 403 });
    }

    const fullAssetPath = validation.realPath || path.join(pluginDir, 'ui', assetPath);
    const assetFile = file(fullAssetPath);

    // 获取插件的CSP策略
    let cspHeader: string | undefined;
    try {
      const permissionManager = getPermissionManager();
      cspHeader = permissionManager.getCSP(pluginName);
    } catch (error) {
      // Permission manager may not be initialized yet, use default CSP
      cspHeader = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'";
    }

    if (await assetFile.exists()) {
      const headers: Record<string, string> = {
        'Content-Type': getContentType(assetPath),
        'Cache-Control': 'public, max-age=3600'
      };

      // 为HTML文件添加CSP header
      if (getContentType(assetPath) === 'text/html') {
        headers['Content-Security-Policy'] = cspHeader;
        // 添加额外的安全headers
        headers['X-Frame-Options'] = 'SAMEORIGIN';
        headers['X-Content-Type-Options'] = 'nosniff';
      }

      return new Response(assetFile, { headers });
    }

    // 如果是 HTML 请求且文件不存在，尝试 serving index.html (SPA 支持)
    if (getContentType(assetPath) === 'text/html') {
      const indexHtmlPath = path.join(pluginDir, 'ui', 'index.html');
      const indexFile = file(indexHtmlPath);
      if (await indexFile.exists()) {
        return new Response(indexFile, {
          headers: {
            'Content-Type': 'text/html',
            'Cache-Control': 'no-cache',
            'Content-Security-Policy': cspHeader,
            'X-Frame-Options': 'SAMEORIGIN',
            'X-Content-Type-Options': 'nosniff'
          }
        });
      }
    }

    return new Response('Asset not found', { status: 404 });
  } catch (error) {
    console.error(`Error serving plugin asset: ${error}`);
    return new Response('Internal Server Error', { status: 500 });
  }
}

function getContentType(path: string): string {
  if (path === '/' || path.endsWith('.html')) return 'text/html';
  if (path.endsWith('.js')) return 'application/javascript';
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.json') || path.endsWith('.webmanifest')) return 'application/json';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.ico')) return 'image/x-icon';
  return 'text/plain';
}

/**
 * 文件类型白名单
 * 只允许以下文件类型被访问
 */
const ALLOWED_FILE_EXTENSIONS = [
  '.html', '.htm',
  '.js', '.mjs', '.cjs',
  '.css',
  '.json',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.txt', '.md'
];

/**
 * 验证插件资源路径的安全性
 * 防止路径遍历攻击
 */
async function validatePluginAssetPath(
  baseDir: string,
  requestedPath: string
): Promise<{ valid: boolean; error?: string; realPath?: string }> {
  try {
    // 1. 规范化请求路径
    const normalizedPath = path.normalize(requestedPath);

    // 2. 拼接完整路径
    const fullPath = path.join(baseDir, 'ui', normalizedPath);

    // 3. 检查文件是否存在
    try {
      await fs.access(fullPath);
    } catch {
      // 文件不存在，不是安全问题，由调用者处理
      return { valid: true, realPath: fullPath };
    }

    // 4. 获取真实路径（解析符号链接）
    const realPath = await fs.realpath(fullPath);

    // 5. 计算相对于基础目录的相对路径
    const baseUiDir = path.join(baseDir, 'ui');
    const relativePath = path.relative(baseUiDir, realPath);

    // 6. 检查是否尝试访问上级目录
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return {
        valid: false,
        error: 'Access denied: path traversal detected'
      };
    }

    // 7. 检查文件类型是否在白名单中
    const ext = path.extname(realPath).toLowerCase();
    if (!ALLOWED_FILE_EXTENSIONS.includes(ext)) {
      return {
        valid: false,
        error: `Access denied: file type ${ext} not allowed`
      };
    }

    return { valid: true, realPath };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
