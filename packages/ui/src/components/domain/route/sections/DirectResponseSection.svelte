<script lang="ts">
  import type { Route } from '$api/routes';
  import { _ } from '$i18n';
  import { PanelCard, StatusBadge, IndustrialToggle } from '$components/industrial';

  export let route: Route;

  type ResponseRule = NonNullable<Route['response_rules']>[number];

  const directStatusCodes = [200, 404, 500, 503];
  const redirectStatusCodes = [301, 302, 307, 308];
  const contentTypes = ['text/plain', 'application/json', 'text/html'];
  const matchTypes: Array<NonNullable<ResponseRule['match_type']>> = ['exact', 'prefix', 'regex'];

  let activeIndex = 0;
  let newHeaderKey = '';
  let newHeaderValue = '';
  let activeRoute = route;

  function resolvePreviewPath(rule: ResponseRule): string {
    const rawPath = rule.path?.trim() || '/';
    const normalizedRulePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    const routePath = route.path === '/' ? '' : route.path.replace(/\/$/, '');

    if (rule.match_type === 'regex') {
      return `${routePath || '/'} ${$_('routeEditor.regexPattern')} ${rawPath}`;
    }

    if (routePath && normalizedRulePath.startsWith(`${routePath}/`)) {
      return normalizedRulePath;
    }

    return `${routePath}${normalizedRulePath}` || '/';
  }

  function ensureRules() {
    route.response_rules ??= [];

    if (route.response_rules.length === 0 && route.direct_response?.enabled) {
      route.response_rules = [{
        enabled: true,
        path: '/',
        match_type: 'prefix',
        type: 'direct_response',
        status: route.direct_response.status,
        body: route.direct_response.body,
        content_type: route.direct_response.content_type,
        headers: route.direct_response.headers,
      }];
    }

    if (route.response_rules.length === 0 && route.redirect?.enabled) {
      route.response_rules = [{
        enabled: true,
        path: '/',
        match_type: 'prefix',
        type: 'redirect',
        status: route.redirect.status,
        url: route.redirect.url,
        preserve_path: route.redirect.preserve_path,
      }];
    }

    route.direct_response = undefined;
    route.redirect = undefined;
  }

  ensureRules();

  $: if (route !== activeRoute) {
    activeRoute = route;
    activeIndex = 0;
    ensureRules();
  }

  $: rules = route.response_rules ?? [];
  $: activeRule = rules[activeIndex];
  $: previewPath = activeRule ? resolvePreviewPath(activeRule) : '';

  function addRule(type: ResponseRule['type'] = 'direct_response') {
    const rule: ResponseRule = type === 'redirect'
      ? { enabled: true, path: '/', match_type: 'exact', type, status: 302, url: '' }
      : { enabled: true, path: '/', match_type: 'exact', type, status: 200, body: '', content_type: 'text/plain', headers: {} };

    route.response_rules = [...(route.response_rules ?? []), rule];
    activeIndex = route.response_rules.length - 1;
  }

  function removeRule(index: number) {
    route.response_rules = (route.response_rules ?? []).filter((_, candidateIndex) => candidateIndex !== index);
    activeIndex = Math.max(0, Math.min(activeIndex, route.response_rules.length - 1));
  }

  function duplicateRule(index: number) {
    const source = route.response_rules?.[index];
    if (!source) return;
    route.response_rules = [...(route.response_rules ?? []), { ...source, headers: { ...(source.headers ?? {}) } }];
    activeIndex = route.response_rules.length - 1;
  }

  function addHeader(rule: ResponseRule) {
    if (!newHeaderKey.trim()) return;
    rule.headers = {
      ...(rule.headers || {}),
      [newHeaderKey.trim()]: newHeaderValue
    };
    newHeaderKey = '';
    newHeaderValue = '';
  }

  function removeHeader(rule: ResponseRule, key: string) {
    if (rule.headers) {
      const nextHeaders = { ...rule.headers };
      delete nextHeaders[key];
      rule.headers = nextHeaders;
    }
  }
</script>

<div class="space-y-6">
  <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
    <div>
      <h3 class="text-lg font-semibold">{$_('routeEditor.directResponse')}</h3>
      <p class="text-sm text-zinc-500 mt-1">{$_('routeEditor.responseRulesHelp')}</p>
    </div>
    <button type="button" class="nx-btn-primary nx-btn-sm" on:click={() => addRule('direct_response')}>
      <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>
      {$_('routeEditor.addResponseRule')}
    </button>
  </div>

  {#if rules.length === 0}
    <PanelCard title={$_('routeEditor.noResponseRulesTitle')} tag="EMPTY" flush>
      <div class="py-8 text-center space-y-4">
        <p class="mx-auto max-w-xl text-sm text-zinc-400">{$_('routeEditor.noResponseRules')}</p>
        <div class="flex justify-center gap-2">
          <button type="button" class="nx-btn-primary nx-btn-sm" on:click={() => addRule('direct_response')}>{$_('routeEditor.directResponseMode')}</button>
          <button type="button" class="nx-btn-outline nx-btn-sm" on:click={() => addRule('redirect')}>{$_('routeEditor.redirectMode')}</button>
        </div>
      </div>
    </PanelCard>
  {:else}
    <div class="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-4">
      <div class="space-y-2">
        {#each rules as rule, index}
          <button
            type="button"
            class="group relative w-full overflow-hidden border p-3 pl-4 text-left transition-all duration-150"
            class:border-nexus-500={activeIndex === index}
            class:bg-carbon-900={activeIndex !== index}
            class:border-carbon-600={activeIndex !== index}
            class:bg-carbon-800={activeIndex === index}
            on:click={() => activeIndex = index}
          >
            <span class="absolute bottom-3 left-0 top-3 w-1 rounded-r-full transition-colors" class:bg-primary={activeIndex === index} class:bg-transparent={activeIndex !== index}></span>
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <span class="block truncate text-base font-semibold text-zinc-100">{rule.path || $_('routeEditor.responseRulePathPlaceholder')}</span>
                <span class="mt-1 block text-xs text-zinc-400">
                  {$_(`routeEditor.matchType_${rule.match_type ?? 'exact'}`)} · {rule.enabled ? $_('auth.enabled') : $_('routeEditor.upstreamDisabled')}
                </span>
              </div>
              <StatusBadge variant={rule.type === 'direct_response' ? 'active' : 'standby'}>
                {rule.type === 'direct_response' ? $_('routeEditor.directResponseMode') : $_('routeEditor.redirectMode')}
              </StatusBadge>
            </div>
          </button>
        {/each}
      </div>

      {#if activeRule}
        <PanelCard title={activeRule.path || $_('routeEditor.responseRulePathPlaceholder')} tag={activeRule.type === 'direct_response' ? 'DIRECT' : 'REDIRECT'}>
          <div class="space-y-5">
            <div class="flex items-start justify-between gap-4 border-b border-carbon-600 pb-4">
              <div class="min-w-0 space-y-2">
                <div class="flex flex-wrap items-center gap-2">
                  <h4 class="truncate text-lg font-semibold">{activeRule.path || $_('routeEditor.responseRulePathPlaceholder')}</h4>
                  <StatusBadge variant={activeRule.type === 'direct_response' ? 'active' : 'standby'}>
                    {activeRule.type === 'direct_response' ? $_('routeEditor.directResponseMode') : $_('routeEditor.redirectMode')}
                  </StatusBadge>
                </div>
                <label class="flex items-center gap-3 cursor-pointer">
                  <IndustrialToggle bind:checked={activeRule.enabled} title={$_('routeEditor.enableResponseRule')} />
                  <span class="text-sm font-semibold">{$_('routeEditor.enableResponseRule')}</span>
                </label>
              </div>
              <div class="flex gap-2">
                <button type="button" class="nx-btn-outline nx-btn-sm" on:click={() => duplicateRule(activeIndex)}>{$_('routeEditor.duplicateRule')}</button>
                <button type="button" class="nx-btn-danger nx-btn-sm" on:click={() => removeRule(activeIndex)}>{$_('common.delete')}</button>
              </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="block space-y-1.5">
                <span class="nx-label">{$_('routeEditor.responseRulePath')}</span>
                <input type="text" class="nx-input w-full" bind:value={activeRule.path} placeholder={$_('routeEditor.responseRulePathPlaceholder')} />
              </label>
              <label class="block space-y-1.5">
                <span class="nx-label">{$_('routeEditor.matchType')}</span>
                <select class="nx-input pr-7 w-full" bind:value={activeRule.match_type}>
                  {#each matchTypes as matchType}
                    <option value={matchType}>{$_(`routeEditor.matchType_${matchType}`)}</option>
                  {/each}
                </select>
              </label>
            </div>

            <div class="rounded border border-carbon-600 bg-carbon-950/60 px-3 py-2 text-sm text-zinc-300">
              <span class="font-semibold text-zinc-100">{$_('routeEditor.effectiveMatchPath')}:</span>
              <code class="ml-2 rounded bg-carbon-700 px-2 py-0.5 font-mono text-zinc-100">{previewPath}</code>
            </div>

            {#if activeRule.type === 'direct_response'}
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label class="block space-y-1.5">
                  <span class="nx-label">{$_('routeEditor.statusCode')}</span>
                  <select class="nx-input pr-7 w-full" bind:value={activeRule.status}>
                    {#each directStatusCodes as code}
                      <option value={code}>{code}</option>
                    {/each}
                  </select>
                </label>
                <label class="block space-y-1.5">
                  <span class="nx-label">{$_('routeEditor.contentType')}</span>
                  <select class="nx-input pr-7 w-full" bind:value={activeRule.content_type}>
                    {#each contentTypes as type}
                      <option value={type}>{type}</option>
                    {/each}
                  </select>
                </label>
              </div>

              <label class="block space-y-1.5">
                <span class="nx-label">{$_('routeEditor.responseBody')}</span>
                <textarea class="nx-input h-32 py-2 resize-y font-mono text-sm" bind:value={activeRule.body} placeholder={$_('body.placeholder')}></textarea>
              </label>

              <div class="space-y-2">
                <div class="nx-label">{$_('routeEditor.customHeaders')}</div>
                {#each Object.entries(activeRule.headers || {}) as [key, value]}
                  <div class="flex gap-2 items-center border border-carbon-600 bg-carbon-900/60 px-3 py-2">
                    <div class="flex-1 font-mono text-sm text-zinc-200">{key}: {value}</div>
                    <button type="button" class="nx-btn-ghost nx-btn-sm" on:click={() => removeHeader(activeRule, key)}>{$_('common.delete')}</button>
                  </div>
                {/each}
                <div class="flex gap-2">
                  <input type="text" class="nx-input w-1/3" placeholder="Key" bind:value={newHeaderKey} />
                  <input type="text" class="nx-input flex-1" placeholder="Value" bind:value={newHeaderValue} on:keydown={(e) => e.key === 'Enter' && addHeader(activeRule)} />
                  <button type="button" class="nx-btn-primary nx-btn-sm" on:click={() => addHeader(activeRule)}>{$_('common.add')}</button>
                </div>
              </div>
            {:else}
              <label class="block space-y-1.5">
                <span class="nx-label">{$_('routeEditor.redirectUrl')}</span>
                <input type="text" class="nx-input w-full" bind:value={activeRule.url} placeholder="https://example.com/new-path" />
              </label>

              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label class="block space-y-1.5">
                  <span class="nx-label">{$_('routeEditor.statusCode')}</span>
                  <select class="nx-input pr-7 w-full" bind:value={activeRule.status}>
                    {#each redirectStatusCodes as code}
                      <option value={code}>{code}</option>
                    {/each}
                  </select>
                </label>
                <label class="flex items-center gap-3">
                  <IndustrialToggle bind:checked={activeRule.preserve_path} title={$_('routeEditor.preservePath')} />
                  <span>
                    <span class="block font-semibold">{$_('routeEditor.preservePath')}</span>
                    <span class="block text-xs text-zinc-500">{$_('routeEditor.preservePathHelp')}</span>
                  </span>
                </label>
              </div>
            {/if}
          </div>
        </PanelCard>
      {/if}
    </div>
  {/if}
</div>
