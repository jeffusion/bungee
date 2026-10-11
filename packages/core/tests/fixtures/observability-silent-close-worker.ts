/// <reference lib="webworker" />
const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = event => {
  if (event.data.method === 'open') scope.postMessage({ id: event.data.id, value: null });
  // Deliberately never acknowledge close: terminate alone is no release proof.
};
scope.postMessage({ type: 'ready' });
