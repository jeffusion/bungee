import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';

const HOP_HEADERS = new Set([
  'connection', 'upgrade', 'keep-alive', 'proxy-connection', 'transfer-encoding',
  'te', 'trailer', 'proxy-authenticate', 'proxy-authorization',
]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function tokens(value: string | null): string[] {
  return (value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
}

/** Ordinary HTTP and other upgrade protocols remain owned by the HTTP router. */
export function isWebSocketUpgradeRequest(request: Request): boolean {
  return tokens(request.headers.get('upgrade')).some((part) => part.toLowerCase() === 'websocket');
}

export function validateWebSocketRequest(request: Request): Response | undefined {
  if (request.method !== 'GET'
    || request.headers.get('upgrade')?.trim().toLowerCase() !== 'websocket'
    || !tokens(request.headers.get('connection')).some((part) => part.toLowerCase() === 'upgrade')) {
    return new Response('Invalid WebSocket upgrade', { status: 400 });
  }
  if (request.headers.get('sec-websocket-version') !== '13') {
    return new Response('Unsupported WebSocket version', {
      status: 426, headers: { 'Sec-WebSocket-Version': '13', Upgrade:'websocket' },
    });
  }
  const key = request.headers.get('sec-websocket-key');
  if (!key || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').byteLength !== 16
    || Buffer.from(key, 'base64').toString('base64') !== key) {
    return new Response('Invalid WebSocket key', { status: 400 });
  }
  const offered = tokens(request.headers.get('sec-websocket-protocol'));
  if (offered.some((protocol) => !TOKEN.test(protocol)) || new Set(offered).size !== offered.length
    || request.headers.get('sec-websocket-protocol')?.split(',').some((protocol) => protocol.trim() === '')
    || (request.headers.has('sec-websocket-protocol') && offered.length === 0)) {
    return new Response('Invalid WebSocket subprotocols', { status: 400 });
  }
  return undefined;
}

export function offeredProtocols(request: Request): string[] {
  return tokens(request.headers.get('sec-websocket-protocol'));
}

function excluded(connection: string | null): Set<string> {
  return new Set([...HOP_HEADERS, ...tokens(connection).map((part) => part.toLowerCase())]);
}

/** ws generates a fresh key, Host, Connection, Upgrade and version for this hop. */
export function upstreamHeaders(headers: Headers, protocols: readonly string[]): OutgoingHttpHeaders {
  const denied = excluded(headers.get('connection'));
  const result: OutgoingHttpHeaders = {};
  headers.forEach((value, name) => {
    if (denied.has(name) || name === 'host' || name === 'content-length'
      || name.startsWith('sec-websocket-')) return;
    result[name] = value;
  });
  if (protocols.length > 0) result['sec-websocket-protocol'] = protocols.join(', ');
  return result;
}

/** rawHeaders retains repeated Set-Cookie; framing and internal headers do not cross hops. */
export function downstreamHeaders(response: IncomingMessage, rejection = false): Headers {
  const denied = excluded(typeof response.headers.connection === 'string' ? response.headers.connection : null);
  const result = new Headers();
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    const name = response.rawHeaders[i]!;
    const lower = name.toLowerCase();
    if (denied.has(lower) || lower.startsWith('sec-websocket-') || lower.startsWith('x-bungee-')
      || lower === 'content-length' || (!rejection && (lower === 'content-encoding' || lower === 'content-type'))) continue;
    result.append(name, response.rawHeaders[i + 1]!);
  }
  return result;
}
