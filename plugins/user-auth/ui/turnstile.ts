export interface TurnstileApi {
  render(container: HTMLElement, options: { sitekey: string; action: string; size: 'flexible'; callback(token: string): void; 'expired-callback'(): void; 'error-callback'(): void }): string;
  reset(id: string): void;
  remove(id: string): void;
}
declare global { interface Window { turnstile?: TurnstileApi } }
let loading: Promise<TurnstileApi> | undefined;
/** One external script per page; rejected loads can be retried explicitly. */
export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    const timer = setTimeout(() => fail(), 15_000);
    const fail = () => { clearTimeout(timer); script.remove(); loading = undefined; reject(new Error('turnstile_unavailable')); };
    script.onload = () => { clearTimeout(timer); if (window.turnstile) resolve(window.turnstile); else fail(); };
    script.onerror = fail;
    document.head.appendChild(script);
  });
}
