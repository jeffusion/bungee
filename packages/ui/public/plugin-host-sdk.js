// Sandboxed HTML plugins delegate only to their own authenticated host frame.
const pending = new Map();
let sequence = 0;
const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== location.origin || event.data?.type !== 'bungee:host-result') return;
  const entry = pending.get(event.data.id);
  if (!entry) return;
  clearTimeout(entry.timer); pending.delete(event.data.id);
  event.data.error ? entry.reject(new Error(event.data.error)) : entry.resolve(event.data.result);
});
export function hostRequest(action, data = {}) {
  if (parent === window) return Promise.reject(new Error('请在 Bungee 插件设置页打开此页面'));
  const id = `plugin-ui-${nonce}-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('宿主响应超时，请刷新状态后重试')); }, 120000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ type: 'bungee:host-request', id, action, ...data }, location.origin);
  });
}
export const control = (method, path, body) => hostRequest('control', { method, path, body });
export async function initializeStyles() {
  const { css } = await hostRequest('ui-context');
  const style = document.createElement('style'); style.textContent = css; document.head.prepend(style);
  document.documentElement.dataset.theme = 'industrial';
}
