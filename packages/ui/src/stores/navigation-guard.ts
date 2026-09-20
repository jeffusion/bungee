import { get, readable, writable } from 'svelte/store';
import { location } from 'svelte-spa-router';
import { _ } from '$i18n';
import { isAuthenticated } from './auth';
import { confirmAction } from './confirmation';

export const settingsDirty = writable(false);

/** Gate the existing router store, not a second router. Keep the editor mounted until a decision. */
export const guardedLocation = readable(get(location), set => {
  if (typeof window === 'undefined') return;
  let current = get(location);
  let asking = false;
  const show = (target: string) => {
    const url = new URL(window.location.href);
    url.hash = `#${target}`;
    const changed = window.location.hash !== url.hash;
    const oldURL = window.location.href;
    if (changed) history.pushState(history.state, '', url);
    current = target;
    set(target);
    if (changed) window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: url.href }));
  };
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (get(settingsDirty)) { event.preventDefault(); event.returnValue = ''; }
  };
  const click = (event: MouseEvent) => {
    if (!get(settingsDirty) || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element | null)?.closest?.('a');
    if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin || url.pathname !== window.location.pathname || !url.hash.startsWith('#/')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    window.location.hash = url.hash;
  };
  window.addEventListener('beforeunload', beforeUnload);
  document.addEventListener('click', click, true);
  const unsubscribe = location.subscribe(target => {
    if (target === current) return;
    if (!get(settingsDirty) || !get(isAuthenticated)) {
      current = target; set(target); return;
    }
    if (asking) { show(current); return; }
    asking = true;
    const t = get(_);
    void confirmAction({ title: t('settings.leaveTitle'), message: t('settings.leaveWarning'),
      confirmText: t('settings.leaveDiscard'), cancelText: t('settings.stay') }).then(leave => {
      asking = false;
      if (leave) {
        settingsDirty.set(false);
        show(target);
      } else show(current);
    });
  });
  return () => { unsubscribe(); document.removeEventListener('click', click, true); window.removeEventListener('beforeunload', beforeUnload); };
});
