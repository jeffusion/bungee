import type { RouteTimeoutsConfig } from '$types';

export type EditorRouteTimeouts = RouteTimeoutsConfig;

export const DEFAULT_REQUEST_MS = 30_000;

// The first-response limit is optional. It never acquires a hidden default in the editor.
export function setFirstResponseMs(current: EditorRouteTimeouts | undefined, firstResponseMs: number | undefined): EditorRouteTimeouts | undefined {
  const next = {
    ...current,
    first_response_ms: firstResponseMs,
    request_ms: firstResponseMs !== undefined && firstResponseMs > (current?.request_ms ?? DEFAULT_REQUEST_MS)
      ? firstResponseMs
      : current?.request_ms,
  };
  return compactTimeouts(next);
}

export function setRequestMs(current: EditorRouteTimeouts | undefined, requestMs: number | undefined): EditorRouteTimeouts | undefined {
  return compactTimeouts({ ...current, request_ms: requestMs });
}

function compactTimeouts(timeouts: EditorRouteTimeouts): EditorRouteTimeouts | undefined {
  const next = Object.fromEntries(Object.entries(timeouts).filter(([, value]) => value !== undefined));
  return Object.keys(next).length ? next : undefined;
}
