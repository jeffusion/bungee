/** A response handler with Bun's full fetch interface, without opening connections. */
export function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(handler, { preconnect() {} });
}
