import { isIP } from 'node:net';

const sources = new WeakMap<Request, string>();
function address(value: string): string {
  const normalized = value.toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  if (!isIP(normalized)) throw new Error('Invalid trusted proxy IP address');
  return normalized;
}
export function parseTrustedManagementProxies(value: string | undefined): readonly string[] {
  return Object.freeze(value ? value.split(',').map(part => address(part.trim())) : []);
}
/** Attach connection evidence to the listener request, never to a client header. */
export function attestManagementRequestSource(request: Request, peer: string | undefined, trustedProxies: readonly string[] = []): void {
  if (!peer) return;
  let source = address(peer);
  if (trustedProxies.includes(source)) {
    const forwarded = request.headers.get('x-forwarded-for')?.trim();
    // Trusted proxies must supply one canonical client address, not an arbitrary chain.
    if (forwarded && isIP(forwarded)) source = address(forwarded);
  }
  sources.set(request, source);
}
export function managementRequestSource(request: Request): string { return sources.get(request) ?? 'unknown'; }
