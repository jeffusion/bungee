import {afterAll, afterEach} from 'bun:test';
import {chromium, type Browser} from 'playwright/test';
import {startUiRuntime} from '../../../../../tests/helpers/ui-runtime';

/** Each entry owns one immutable server/browser; each case owns fresh contexts. */
export function createAuthRuntime(mode: 'built-page' | 'component-fixture' = 'built-page', entries?: string[]) {
  let runtime: Awaited<ReturnType<typeof startUiRuntime>> | undefined;
  let browser: Browser | undefined;
  async function authRuntime() {
    if (!runtime) {
      if (mode === 'component-fixture' && !entries?.length) throw new Error('Authentication component runtime requires explicit entries');
      runtime = await startUiRuntime(mode === 'built-page' ? {mode:'built-page'} : {mode:'component-fixture',entries:entries!});
      try { browser = await chromium.launch({headless: true}); }
      catch (error) {
        try { await runtime.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Authentication browser startup cleanup failed'); }
        finally { runtime = undefined; }
        throw error;
      }
    }
    return {runtime, browser: browser!};
  }
  async function closeAuthContexts() {
    const results = await Promise.allSettled((browser?.contexts() ?? []).map(context => context.close()));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Authentication context cleanup failed');
  }
  afterEach(closeAuthContexts);
  afterAll(async () => {
    const errors: unknown[] = [];
    try { await browser?.close(); } catch (error) { errors.push(error); }
    try { await runtime?.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Authentication runtime cleanup failed');
  });
  return {authRuntime, closeAuthContexts};
}
