import { writable } from 'svelte/store';

export type ConfirmationRequest = { title: string; message: string; confirmText: string; cancelText: string };
export const confirmation = writable<(ConfirmationRequest & { opener: HTMLElement | null }) | null>(null);
let resolvePending: ((accepted: boolean) => void) | null = null;
export function confirmAction(request: ConfirmationRequest): Promise<boolean> {
  if (resolvePending) return Promise.resolve(false);
  const opener = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  return new Promise(resolve => { resolvePending = resolve; confirmation.set({ ...request, opener }); });
}
export function answerConfirmation(accepted: boolean) {
  const resolve = resolvePending; resolvePending = null; confirmation.set(null); resolve?.(accepted);
}
