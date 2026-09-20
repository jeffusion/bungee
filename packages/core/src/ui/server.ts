import { lstat, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative } from 'node:path';
import { getAsset } from './assets';
import { createPluginSandboxPolicy } from './plugin-sandbox-policy';
import type { PluginManifestCatalog } from '../plugin-manifest-catalog';
import type { PluginManifestRecord } from '../plugin-manifest-catalog/types';
import type { RepositorySnapshot } from '../config-storage/repository-types';

type SnapshotProvider = () => RepositorySnapshot | Promise<RepositorySnapshot>;

export interface MasterUIHandlerOptions {
  readonly catalog: Pick<PluginManifestCatalog, 'get'>;
  readonly getRepositorySnapshot: SnapshotProvider;
}

export type MasterUIHandler = (request: Request) => Promise<Response | null>;

const ALLOWED_FILE_EXTENSIONS = new Set([
  '.html', '.htm', '.js', '.mjs', '.cjs', '.css', '.json', '.webmanifest',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
  '.woff', '.woff2', '.ttf', '.eot', '.txt', '.md',
]);

function contentType(requestPath: string): string {
  if (requestPath === '/' || requestPath === '/index.html') return 'text/html';
  const extension = extname(requestPath).toLowerCase();
  switch (extension) {
    case '.html':
    case '.htm': return 'text/html';
    case '.js':
    case '.mjs':
    case '.cjs': return 'application/javascript';
    case '.css': return 'text/css';
    case '.json':
    case '.webmanifest': return 'application/json';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.svg': return 'image/svg+xml';
    case '.webp': return 'image/webp';
    case '.ico': return 'image/x-icon';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    case '.eot': return 'application/vnd.ms-fontobject';
    default: return 'text/plain';
  }
}

function methodAllowed(request: Request): boolean {
  return request.method === 'GET' || request.method === 'HEAD';
}

function responseForAsset(
  request: Request,
  body: string | Blob,
  headers: Record<string, string>,
): Response {
  return new Response(request.method === 'HEAD' ? null : body, { headers });
}

function response(
  request: Request,
  body: string | null,
  init: ResponseInit = {},
): Response {
  return new Response(request.method === 'HEAD' ? null : body, init);
}

function assetLength(asset: string | Blob): number {
  return typeof asset === 'string' ? new TextEncoder().encode(asset).byteLength : asset.size;
}

function decodePath(rawPath: string): string | null {
  try {
    const decoded = decodeURIComponent(rawPath);
    if (decoded.includes('%') || decoded.includes('\0') || decoded.includes('\\')) return null;
    return decoded;
  } catch {
    return null;
  }
}

function hostileAssetPath(assetPath: string, rawPath: string): boolean {
  if (/%2f|%5c/i.test(rawPath)) return true;
  if (assetPath.length === 0 || assetPath.startsWith('/') || isAbsolute(assetPath)) return true;
  return assetPath.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..');
}

type AssetResult =
  | { readonly kind: 'file'; readonly path: string; readonly size: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'forbidden'; readonly message: string };

async function resolvePluginAsset(uiRoot: string, assetPath: string): Promise<AssetResult> {
  const extension = extname(assetPath).toLowerCase();
  if (!ALLOWED_FILE_EXTENSIONS.has(extension)) {
    return { kind: 'forbidden', message: `file type ${extension || '(none)'} not allowed` };
  }

  const rootStatus = await lstat(uiRoot).catch(() => null);
  if (rootStatus === null) return { kind: 'missing' };
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    return { kind: 'forbidden', message: 'ui root must be a non-symlink directory' };
  }

  const segments = assetPath.split('/');
  let current = uiRoot;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let status: Awaited<ReturnType<typeof lstat>>;
    try {
      status = await lstat(current);
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        return { kind: 'missing' };
      }
      return { kind: 'forbidden', message: 'asset cannot be inspected' };
    }
    if (status.isSymbolicLink()) return { kind: 'forbidden', message: 'symbolic links are not allowed' };
    if (index < segments.length - 1 && !status.isDirectory()) {
      return { kind: 'missing' };
    }
    if (index === segments.length - 1 && !status.isFile()) {
      return { kind: 'forbidden', message: 'asset must be a regular file' };
    }
  }

  const physical = await realpath(current).catch(() => null);
  if (physical === null) return { kind: 'missing' };
  const relation = relative(uiRoot, physical);
  if (relation.startsWith('..') || isAbsolute(relation)) {
    return { kind: 'forbidden', message: 'asset path escapes ui root' };
  }
  const status = await lstat(current);
  return { kind: 'file', path: physical, size: status.size };
}

async function servePluginAsset(
  request: Request,
  record: PluginManifestRecord,
  assetPath: string,
): Promise<Response> {
  if (record.uiRoot === undefined) return response(request, 'UI root not found', { status: 404 });
  const resolved = await resolvePluginAsset(record.uiRoot, assetPath);
  if (resolved.kind === 'missing') return response(request, 'Asset not found', { status: 404 });
  if (resolved.kind === 'forbidden') return response(request, `Access denied: ${resolved.message}`, { status: 403 });

  const type = contentType(assetPath);
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Cache-Control': type === 'text/html' ? 'no-cache' : 'public, max-age=3600',
    'Content-Length': String(resolved.size),
    'X-Content-Type-Options': 'nosniff',
  };
  if (type === 'text/html') {
    headers['Content-Security-Policy'] = createPluginSandboxPolicy(record.manifest).csp;
    headers['X-Frame-Options'] = 'SAMEORIGIN';
  }
  return responseForAsset(request, Bun.file(resolved.path), headers);
}

async function bundledUI(request: Request, requestPath: string): Promise<Response> {
  const asset = getAsset(requestPath) ?? ((requestPath === '/' || requestPath === '/index.html') ? getAsset('/') : null);
  if (asset !== null) {
    return responseForAsset(request, asset, {
      'Content-Type': contentType(requestPath),
      'Content-Length': String(assetLength(asset)),
    });
  }
  return response(request, 'Not Found', { status: 404 });
}

export function createMasterUIHandler(options: MasterUIHandlerOptions): MasterUIHandler {
  return async (request: Request): Promise<Response | null> => {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api' || pathname.startsWith('/api/')) return null;
    if (!methodAllowed(request)) return response(request, 'Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });

    if (pathname === '/plugins' || pathname.startsWith('/plugins/')) {
      if (pathname === '/plugins') return response(request, 'Not Found', { status: 404 });
      const rawPluginPath = pathname.slice('/plugins/'.length);
      const decodedPluginPath = decodePath(rawPluginPath);
      if (decodedPluginPath === null || hostileAssetPath(decodedPluginPath, rawPluginPath)) {
        return response(request, 'Access denied', { status: 403 });
      }
      const slash = decodedPluginPath.indexOf('/');
      if (slash <= 0) return response(request, 'Asset not found', { status: 404 });
      const pluginName = decodedPluginPath.slice(0, slash);
      const record = options.catalog.get(pluginName);
      if (record === undefined) return response(request, 'Plugin not found', { status: 404 });
      const active = new Set((await options.getRepositorySnapshot()).aggregate.plugin_activations
        .map(({ plugin_name }) => plugin_name));
      if (!active.has(pluginName)) return response(request, 'Plugin is not active', { status: 404 });
      if (record.manifest.uiExtensionMode !== 'sandbox-iframe') {
        return response(request, 'UI extension (sandbox-iframe) not enabled for this plugin', { status: 403 });
      }
      if (!record.manifest.capabilities.includes('sandboxUiExtension')) {
        return response(request, 'Plugin missing required capability: sandboxUiExtension', { status: 403 });
      }
      return servePluginAsset(request, record, decodedPluginPath.slice(slash + 1));
    }

    const decodedPath = decodePath(pathname);
    if (decodedPath === null) return response(request, 'Not Found', { status: 404 });
    if (decodedPath !== '/' && decodedPath !== '/index.html' && getAsset(decodedPath) === null) {
      return response(request, 'Not Found', { status: 404 });
    }
    return bundledUI(request, decodedPath);
  };
}
