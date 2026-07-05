<script lang="ts">
  import type { Route } from '$api/routes';
  import { _ } from '$i18n';
  import { PanelCard, StatusBadge, BSwitch, BSelect } from '$components/industrial';
  import { Input } from '$components/ui/input';
  import { Textarea } from '$components/ui/textarea';
  import { Button } from '$components/ui/button';

  export let route: Route;

  type ResponseRule = NonNullable<Route['response_rules']>[number];

  const directStatusCodes = [200, 404, 500, 503];
  const redirectStatusCodes = [301, 302, 307, 308];
  const contentTypes = ['text/plain', 'application/json', 'text/html'];
  const matchTypes: Array<NonNullable<ResponseRule['match_type']>> = ['exact', 'prefix', 'regex'];

  $: matchTypeOptions = matchTypes.map(t => ({ value: t, label: $_(`routeEditor.matchType_${t}`) }));
  $: directStatusCodeOptions = directStatusCodes.map(c => ({ value: String(c), label: String(c) }));
  $: redirectStatusCodeOptions = redirectStatusCodes.map(c => ({ value: String(c), label: String(c) }));
  $: contentTypeOptions = contentTypes.map(t => ({ value: t, label: t }));

  let activeIndex = 0;
  let newHeaderKey = '';
  let newHeaderValue = '';
  let showAddMenu = false;

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
        preserve_path: route.redirect.preserve_path ?? false,
      }];
    }

    route.direct_response = undefined;
    route.redirect = undefined;
  }

  onMount(() => {
    ensureRules();
  });

  $: rules = route.response_rules ?? [];
  $: activeRule = rules[activeIndex];
  $: previewPath = activeRule ? resolvePreviewPath(activeRule) : '';

  function addRule(type: ResponseRule['type'] = 'direct_response') {
    const rule: ResponseRule = type === 'redirect'
      ? { enabled: true, path: '/', match_type: 'exact', type, status: 302, url: '', preserve_path: false }
      : { enabled: true, path: '/', match_type: 'exact', type, status: 200, body: '', content_type: 'text/plain', headers: {} };

    route.response_rules = [...(route.response_rules ?? []), rule];
    activeIndex = route.response_rules.length - 1;
    showAddMenu = false;
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

  function handleMatchTypeChange(rule: ResponseRule, value: string) {
    rule.match_type = value as ResponseRule['match_type'];
  }

  function handleStatusChange(rule: ResponseRule, value: string) {
    rule.status = parseInt(value) || 200;
  }

  function handleContentTypeChange(rule: ResponseRule, value: string) {
    rule.content_type = value;
  }

  function closeAddMenu() {
    showAddMenu = false;
  }

  import { onMount } from 'svelte';
</script>

<svelte:window on:click={closeAddMenu} />

<div class="space-y-6">
  <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
    <div>
      <h3 class="text-lg font-semibold">{$_('routeEditor.directResponse')}</h3>
      <p class="text-sm text-zinc-500 mt-1">{$_('routeEditor.responseRulesHelp')}</p>
    </div>
    <div class="relative" on:click|stopPropagation>
      <div class="inline-flex">
        <Button variant="default" size="sm" class="rounded-r-none border-r-0" onclick={() => addRule('direct_response')}>
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>
          {$_('routeEditor.directResponseMode')}
        </Button>
        <Button variant="default" size="sm" class="rounded-l-none px-2" onclick={() => showAddMenu = !showAddMenu}>
          <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7" /></svg>
        </Button>
      </div>
      {#if showAddMenu}
        <div class="absolute right-0 top-full mt-1 z-50 border-2 border-carbon-500 bg-carbon-900 shadow-industrial-lg py-1 min-w-[180px]">
          <button
            type="button"
            class="w-full text-left px-3 py-1.5 text-sm text-zinc-200 hover:bg-carbon-700 transition-colors cursor-pointer"
            on:click={() => addRule('redirect')}
          >
            {$_('routeEditor.redirectMode')}
          </button>
        </div>
      {/if}
    </div>
  </div>

  {#if rules.length === 0}
    <PanelCard label={$_('routeEditor.noResponseRulesTitle')} tag="EMPTY" flush>
      <div class="py-8 text-center space-y-4">
        <p class="mx-auto max-w-xl text-sm text-zinc-400">{$_('routeEditor.noResponseRules')}</p>
        <div class="flex justify-center gap-2">
          <Button variant="default" size="sm" onclick={() => addRule('direct_response')}>{$_('routeEditor.directResponseMode')}</Button>
          <Button variant="outline" size="sm" onclick={() => addRule('redirect')}>{$_('routeEditor.redirectMode')}</Button>
        </div>
      </div>
    </PanelCard>
  {:else}
    <div class="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-4">
      <div class="space-y-2">
        {#each rules as rule, index}
          <button
            type="button"
            class="group relative w-full overflow-hidden border p-3 pl-4 text-left transition-all duration-150 cursor-pointer"
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
        <PanelCard title={activeRule.type === 'direct_response' ? $_('routeEditor.directResponseMode') : $_('routeEditor.redirectMode')}>
          <svelte:fragment slot="actions">
            <Button variant="outline" size="sm" onclick={() => duplicateRule(activeIndex)}>{$_('routeEditor.duplicateRule')}</Button>
            <Button variant="destructive" size="sm" onclick={() => removeRule(activeIndex)}>{$_('common.delete')}</Button>
          </svelte:fragment>
          <div class="space-y-5">
            <BSwitch checked={!!activeRule.enabled} label={$_('routeEditor.enableResponseRule')} onchange={(v) => { activeRule.enabled = v; }} />

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="block space-y-1.5">
                <span class="font-mono text-[11px] uppercase tracking-command text-zinc-400">{$_('routeEditor.responseRulePath')}</span>
                <Input type="text" value={activeRule.path ?? ''} oninput={(e) => { activeRule.path = (e.target as HTMLInputElement).value; }} placeholder={$_('routeEditor.responseRulePathPlaceholder')} />
              </label>
              <label class="block space-y-1.5">
                <span class="font-mono text-[11px] uppercase tracking-command text-zinc-400">{$_('routeEditor.matchType')}</span>
                <BSelect options={matchTypeOptions} value={activeRule.match_type ?? 'exact'} onchange={(v) => handleMatchTypeChange(activeRule, v)} />
              </label>
            </div>

            <div class="border border-carbon-600 bg-carbon-950/60 px-3 py-2 text-sm text-zinc-300">
              <span class="font-semibold text-zinc-100">{$_('routeEditor.effectiveMatchPath')}:</span>
              <code class="ml-2 bg-carbon-700 px-2 py-0.5 font-mono text-zinc-100">{previewPath}</code>
            </div>

            {#if activeRule.type === 'direct_response'}
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label class="block space-y-1.5">
                  <span class="font-mono text-[11px] uppercase tracking-command text-zinc-400">{$_('routeEditor.statusCode')}</span>
                  <BSelect options={directStatusCodeOptions} value={String(activeRule.status ?? 200)} onchange={(v) => handleStatusChange(activeRule, v)} />
                </label>
                <label class="block space-y-1.5">
                  <span class="font-mono text-[11px] uppercase tracking-command text-zinc-400">{$_('routeEditor.contentType')}</span>
                  <BSelect options={contentTypeOptions} value={activeRule.content_type ?? 'text/plain'} onchange={(v) => handleContentTypeChange(activeRule, v)} />
                </label>
              </div>

              <label class="block space-y-1.5">
                <span class="font-mono text-[11px] uppercase tracking-command text-zinc-400">{$_('routeEditor.responseBody')}</span>
                <Textarea class="h-32 resize-y font-mono text-sm" value={activeRule.body ?? ''} oninput={(e) => { activeRule.body = (e.target as HTMLTextAreaElement).value; }} placeholder={$_('body.placeholder')} />
              </label>

              <div class="space-y-2">
                <div class="font-mono text-[11px] uppercase tracking-command text-zinc-400">{$_('routeEditor.customHeaders')}</div>
                {#each Object.entries(activeRule.headers || {}) as [key, value]}
                  <div class="flex gap-2 items-center border border-carbon-600 bg-carbon-900/60 px-3 py-2">
                    <div class="flex-1 font-mono text-sm text-zinc-200">{key}: {value}</div>
                    <Button variant="ghost" size="sm" onclick={() => removeHeader(activeRule, key)}>{$_('common.delete')}</Button>
                  </div>
                {/each}
                <div class="flex gap-2">
                  <Input type="text" class="w-1/3" placeholder="Key" value={newHeaderKey} oninput={(e) => { newHeaderKey = (e.target as HTMLInputElement).value; }} />
                  <Input type="text" class="flex-1" placeholder="Value" value={newHeaderValue} oninput={(e) => { newHeaderValue = (e.target as HTMLInputElement).value; }} onkeydown={(e) => e.key === 'Enter' && addHeader(activeRule)} />
                  <Button variant="default" size="default" onclick={() => addHeader(activeRule)}>{$_('common.add')}</Button>
                </div>
              </div>
            {:else}
              <label class="block space-y-1.5">
                <span class="font-mono text-[11px] uppercase tracking-command text-zinc-400">{$_('routeEditor.redirectUrl')}</span>
                <Input type="text" value={activeRule.url ?? ''} oninput={(e) => { activeRule.url = (e.target as HTMLInputElement).value; }} placeholder="https://example.com/new-path" />
              </label>

              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label class="block space-y-1.5">
                  <span class="font-mono text-[11px] uppercase tracking-command text-zinc-400">{$_('routeEditor.statusCode')}</span>
                  <BSelect options={redirectStatusCodeOptions} value={String(activeRule.status ?? 302)} onchange={(v) => handleStatusChange(activeRule, v)} />
                </label>
                <BSwitch
                  checked={!!activeRule.preserve_path}
                  label={$_('routeEditor.preservePath')}
                  description={$_('routeEditor.preservePathHelp')}
                />
              </div>
            {/if}
          </div>
        </PanelCard>
      {/if}
    </div>
  {/if}
</div>
