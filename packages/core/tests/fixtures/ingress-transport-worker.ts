import { restoreWorkerTransportRequest } from '../../src/config-worker/private-transport';

const port = Number(process.env.BUNGEE_FIXTURE_PORT);
const secret = process.env.BUNGEE_FIXTURE_TRANSPORT_SECRET;
const label = process.env.BUNGEE_FIXTURE_LABEL ?? 'worker';
if (!Number.isSafeInteger(port) || port <= 0 || secret === undefined) throw new Error('worker fixture configuration is invalid');

Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: async (request) => {
    const restored = restoreWorkerTransportRequest(request, secret);
    if (!restored.ok) return new Response('invalid transport', { status: restored.status });
    const url = new URL(restored.request.url);
    if (url.pathname === '/hold') await Bun.sleep(250);
    return new Response(`${label}:${url.pathname}`);
  },
});
