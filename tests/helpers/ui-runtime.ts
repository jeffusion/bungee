import { createServer as createPortProbe } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep, relative, posix } from 'node:path';
import type { Alias } from 'vite';

type UiRuntimeOptions =
  | { mode: 'built-page'; buildDirectory?: string }
  | { mode: 'component-fixture'; entries: string[]; aliases?: Alias[] };

/** One owned service per test file and mode; browser contexts belong to each test. */
export async function startUiRuntime(options: UiRuntimeOptions) {
  const root = resolve(import.meta.dir, '../../packages/ui');
  const evidence = await mkdtemp(join(tmpdir(), 'bungee-ui-test-'));
  let stop: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const failures: unknown[] = [];
    try { await stop?.(); } catch (error) { failures.push(error); }
    try { await rm(evidence, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'UI test runtime cleanup failed');
  })();
  try {
    let origin: string;
    if (options.mode === 'built-page') {
      const directory = resolve(options.buildDirectory ?? join(root, 'dist'));
      const index = Bun.file(join(directory, 'index.html'));
      if (!await index.exists()) throw new Error(`Missing UI build: ${directory}/index.html; run bun run build first`);
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
        let pathname: string;
        try { pathname = decodeURIComponent(new URL(request.url).pathname); }
        catch { return new Response('Invalid path', { status: 400 }); }
        const path = resolve(directory, `.${pathname}`);
        if (!path.startsWith(directory + sep) && path !== directory) return new Response('Not found', { status: 404 });
        let file = Bun.file(path === directory ? join(directory, 'index.html') : path);
        if (!await file.exists()) {
          // A missing asset/API/fixture must remain an error, never HTML in place of JavaScript.
          const page = !extname(pathname) && !/^\/(?:assets|api|plugins|tests|src|@)(?:\/|$)/.test(pathname)
            && request.headers.get('accept')?.includes('text/html');
          if (!page) return new Response('Not found', { status: 404 });
          file = index;
        }
        return new Response(request.method === 'HEAD' ? null : file, {
          headers: { 'Content-Type': file.type || 'application/octet-stream', 'Cache-Control': 'no-store' },
        });
      } });
      stop = async () => { await server.stop(true); };
      origin = server.url.origin;
    } else {
      const [{ createServer }, { default: appConfig }] = await Promise.all([
        import('vite'), import('../../packages/ui/vite.config'),
      ]);
      const probe = createPortProbe();
      const port = await new Promise<number>((resolvePort, reject) => {
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
          const address = probe.address();
          if (!address || typeof address === 'string') {
            probe.close(); reject(new Error('UI port probe unavailable')); return;
          }
          probe.close(error => error ? reject(error) : resolvePort(address.port));
        });
      });
      const previousDirectory = process.cwd();
      process.chdir(root);
      let server: Awaited<ReturnType<typeof createServer>> | undefined;
      stop = async () => {
        try {
          // Vite's close can finish while a scan/crawl callback still owns an optimizer.
          // Await its actual work before removing the cache, including startup without navigation.
          try {
            await Promise.all(Object.values(server?.environments ?? {}).map(async environment => {
              const optimizer = environment.depsOptimizer;
              await optimizer?.scanProcessing;
              await Promise.all(Object.values(optimizer?.metadata.discovered ?? {}).map(dependency => dependency.processing));
            }));
          } finally {
            server?.httpServer?.closeAllConnections();
            await server?.close();
          }
        }
        finally { process.chdir(previousDirectory); }
      };
      server = await createServer({
        ...appConfig, configFile: false, root, cacheDir: join(evidence, 'cache'),
        resolve: { ...appConfig.resolve, alias: [...(options.aliases ?? []), ...(appConfig.resolve?.alias as Alias[] ?? [])] },
        optimizeDeps: { ...appConfig.optimizeDeps, entries: options.entries },
        server: { host: '127.0.0.1', port, strictPort: true, proxy: {} },
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('UI fixture did not bind an owned local port');
      // Prepare the fixture's static module graph before the browser's navigation budget starts.
      // Vite's HTML transform schedules its normal pre-transforms; no fixture code runs here.
      for (const entry of options.entries) {
        const file = resolve(root, entry);
        const url = file.startsWith(root + sep)
          ? `/${relative(root, file).split(sep).join('/')}`
          : posix.join('/@fs/', file.split(sep).join('/'));
        if (extname(file) === '.html') await server.transformIndexHtml(url, await Bun.file(file).text());
        else await server.warmupRequest(url);
      }
      await server.waitForRequestsIdle();
      for (const environment of Object.values(server.environments)) {
        const optimizer = environment.depsOptimizer;
        await optimizer?.scanProcessing;
        await Promise.all(Object.values(optimizer?.metadata.discovered ?? {}).map(dependency => dependency.processing));
      }
      origin = `http://127.0.0.1:${address.port}`;
    }
    return { origin, evidence, close };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'UI test runtime startup and cleanup failed'); }
    throw error;
  }
}
