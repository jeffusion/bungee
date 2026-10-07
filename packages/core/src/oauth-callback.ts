import { createServer } from 'node:http';

const CALLBACK_PATH = '/auth/callback';

/** A browser-local companion. It captures a code, never exchanges or stores tokens. */
export async function captureOAuthCallback(options: {
  port?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onListening?: (port: number) => void;
} = {}): Promise<string> {
  const port = options.port ?? 1455;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid callback listener options');
  let settle!: (callback: string) => void;
  let fail!: (error: Error) => void;
  let completed = false;
  const result = new Promise<string>((resolve, reject) => { settle = resolve; fail = reject; });
  const reject = (message: string) => {
    if (completed) return;
    completed = true;
    fail(new Error(message));
  };
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const address = server.address();
    const actualPort = address && typeof address === 'object' ? address.port : port;
    const raw = request.url ?? '';
    let url: URL;
    try { url = new URL(raw, `http://127.0.0.1:${actualPort}`); }
    catch { response.writeHead(400).end('Invalid callback.'); return; }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const clientId = url.searchParams.get('client_id');
    const valid = request.method === 'GET' && raw.split('?')[0] === CALLBACK_PATH && raw.length <= 4096 &&
      !url.hash && !url.searchParams.has('error') && !url.searchParams.has('error_description') &&
      [...url.searchParams.keys()].every(key => url.searchParams.getAll(key).length === 1) &&
      [code, state].every(value => typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)) &&
      typeof clientId === 'string' && /^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(clientId);
    if (!valid) { response.writeHead(400).end('Invalid callback. Continue with the Bungee authorization page.'); return; }
    if (completed) { response.writeHead(409).end('Callback already captured.'); return; }
    completed = true;
    response.writeHead(200).end('Callback captured. Paste the complete URL shown in your terminal into Bungee to finish signing in.');
    settle(url.toString());
  });
  server.on('error', () => reject('Cannot listen on 127.0.0.1. Check whether the callback port is occupied.'));
  const abort = () => reject('Callback capture cancelled.');
  const timer = setTimeout(() => reject('Callback capture timed out. Start a new Bungee login.'), timeoutMs);
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) abort();
    else server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') options.onListening?.(address.port);
    });
    return await result;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    server.closeIdleConnections();
    server.close();
    server.closeAllConnections();
  }
}

export async function oauthCallbackCommand(): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const url = await captureOAuthCallback({ signal: controller.signal, onListening: () => {
      console.error('Listening on 127.0.0.1:1455. Open the SIWC authorization URL from Bungee.');
      console.error('The printed callback contains a one-time login code. Paste it only into your Bungee login window.');
    } });
    console.log(url);
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
