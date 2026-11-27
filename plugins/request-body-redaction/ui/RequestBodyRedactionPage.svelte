<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { locale } from 'svelte-i18n';
  import { BSelect, LoadingIndicator, PanelCard, StatusBadge } from '$components/industrial';
  import { Button } from '$components/ui/button';
  import { confirmAction } from '$stores/confirmation';
  import { editorDirty } from '$stores/navigation-guard';
  import RedactionRulesEditor from './RedactionRulesEditor.svelte';
  import RequestBodyRedactionStats from './RequestBodyRedactionStats.svelte';
  import { loadRedactionRoutes, RedactionRouteConflictError, redactionConfigurationWrite, saveRedactionRouteBinding, type RedactionRouteBinding } from './route-bindings';

  let { pluginName = 'request-body-redaction' }: { pluginName?: string } = $props();
  const uid = $props.id();
  const pickerId = `${uid}-route`;
  const copy = $derived($locale?.startsWith('zh') ? {
    title: '请求脱敏', intro: '当前仅处理 JSON 正文中的字符串值。',
    routes: '路由绑定', route: '路由', choose: '选择路由', rules: '脱敏规则', ready: '已绑定', off: '已停用', unbound: '未绑定',
    search: '搜索路由', noMatch: '没有匹配的路由',
    bind: '绑定并保存规则', enable: '启用并保存规则', save: '保存规则', unbind: '解除绑定', cancel: '取消', keep: '继续编辑',
    discard: '放弃草稿', discardTitle: '放弃草稿？', discardMessage: '未保存的修改将丢失。',
    unbindTitle: '解除绑定？', unbindMessage: (path: string) => `解绑将删除 ${path} 的脱敏规则。`,
    loading: '加载路由…', noRoutes: '请先在路由管理中创建路由。', retry: '重试', saving: '保存中…',
    saved: '规则已保存，生效可能有延迟。', removed: '解绑已保存，生效可能有延迟。',
    loadError: '无法加载路由。', saveError: '保存结果未确认。',
    conflict: '路由配置已变更，本次未保存。',
    reload: '放弃草稿并重新加载', reloadClean: '重新加载路由',
    writeBlocked: '上次保存结果未确认。请在「全局设置」核对后再提交。',
  } : {
    title: 'Request Redaction', intro: 'Currently redacts only string values in JSON bodies.',
    routes: 'Route bindings', route: 'Route', choose: 'Select a route', rules: 'Redaction rules', ready: 'Bound', off: 'Disabled', unbound: 'Not bound',
    search: 'Search routes', noMatch: 'No matching routes',
    bind: 'Bind and save rules', enable: 'Enable and save rules', save: 'Save rules', unbind: 'Unbind', cancel: 'Cancel', keep: 'Keep editing',
    discard: 'Discard draft', discardTitle: 'Discard draft?', discardMessage: 'Unsaved changes will be lost.',
    unbindTitle: 'Unbind?', unbindMessage: (path: string) => `Unbinding deletes the redaction rules for ${path}.`,
    loading: 'Loading routes…', noRoutes: 'Create a route in Route Management first.', retry: 'Retry', saving: 'Saving…',
    saved: 'Rules saved. They may take effect later.', removed: 'Unbinding saved. It may take effect later.',
    loadError: 'Could not load routes.', saveError: 'Save unconfirmed.',
    conflict: 'The route configuration changed. Nothing was saved.',
    reload: 'Discard draft and reload', reloadClean: 'Reload routes',
    writeBlocked: 'Previous save unconfirmed. Check Global Settings before saving again.',
  });

  let routes = $state<RedactionRouteBinding[]>([]);
  let selected = $state('');
  let pickerValue = $state('');
  let draft = $state<unknown>(undefined);
  let invalid = $state(false);
  let revision = $state(0);
  let loading = $state(true);
  let saving = $state(false);
  let loadFailed = $state(false);
  let problem = $state<'conflict' | 'saveError' | null>(null);
  let notice = $state<'saved' | 'removed' | null>(null);
  const route = $derived(routes.find(item => item.id === selected));
  const dirty = $derived(!!route && JSON.stringify(draft) !== JSON.stringify(route.binding?.rules));
  const canSaveRules = $derived(Array.isArray(draft) && !!draft.length && !invalid && (dirty || route?.binding?.enabled === false));
  const writeBlocked = $derived($redactionConfigurationWrite.corrupt || !!($redactionConfigurationWrite.pending && !$redactionConfigurationWrite.pending.accepted));
  let mounted = false;

  onMount(() => {
    mounted = true;
    void refresh();
    return () => {
      mounted = false;
      editorDirty.set(false);
    };
  });

  $effect(() => { editorDirty.set(dirty || saving); });

  function openRoute(id: string) {
    selected = id;
    pickerValue = id;
    draft = routes.find(item => item.id === id)?.binding?.rules;
    invalid = false;
    problem = null;
    notice = null;
    revision++;
  }

  async function refresh() {
    loading = true;
    loadFailed = false;
    try {
      const result = await loadRedactionRoutes();
      if (!mounted) return;
      routes = result;
      openRoute(result.some(item => item.id === selected) ? selected : '');
    } catch {
      if (mounted) loadFailed = true;
    } finally {
      if (mounted) loading = false;
    }
  }

  function confirmDiscard() {
    return confirmAction({ title: copy.discardTitle, message: copy.discardMessage, confirmText: copy.discard, cancelText: copy.keep });
  }

  async function selectRoute(id: string | string[]) {
    if (typeof id !== 'string' || id === selected || saving || loading) return;
    if (dirty && !await confirmDiscard()) {
      pickerValue = selected;
      return;
    }
    if (mounted) openRoute(id);
  }

  async function reload() {
    if (dirty && !await confirmDiscard()) return;
    if (mounted) await refresh();
  }

  async function commit(unbind: boolean) {
    const baseline = route;
    if (!baseline || problem === 'conflict' || loading || saving || writeBlocked) return;
    if (unbind) {
      if (!baseline.binding || !await confirmAction({
        title: copy.unbindTitle, message: copy.unbindMessage(baseline.path), confirmText: copy.unbind, cancelText: copy.cancel,
      })) return;
      if (!mounted || route !== baseline || saving || loading || writeBlocked) return;
    } else if (!canSaveRules) return;

    saving = true;
    problem = null;
    notice = null;
    try {
      const result = await saveRedactionRouteBinding($state.snapshot(baseline), unbind ? null : $state.snapshot(draft) as unknown[]);
      if (!mounted || selected !== baseline.id) return;
      routes = routes.map(item => item.id === result.id ? result : item);
      openRoute(result.id);
      notice = unbind ? 'removed' : 'saved';
    } catch (error) {
      if (mounted && selected === baseline.id) problem = error instanceof RedactionRouteConflictError ? 'conflict' : 'saveError';
    } finally {
      if (mounted) {
        saving = false;
        if (notice === 'removed') {
          await tick();
          if (mounted) document.getElementById(pickerId)?.focus();
        }
      }
    }
  }
</script>

<div class="nx-page space-y-5 py-5" data-testid="request-body-redaction-page">
  <header class="space-y-1">
    <div class="flex items-center gap-3">
      <span class="nx-stripe" aria-hidden="true"></span>
      <h1 class="nx-display text-xl text-zinc-50">{copy.title}</h1>
    </div>
    <p class="text-sm text-zinc-400">{copy.intro}</p>
  </header>

  <RequestBodyRedactionStats {pluginName} />

  <PanelCard title={copy.routes}>
    <div class="space-y-4" data-testid="request-body-redaction-bindings">
      {#if loadFailed}
        <p role="alert" class="text-sm text-red-300">{copy.loadError}</p>
        <Button variant="outline" size="sm" onclick={reload} disabled={loading}>{copy.retry}</Button>
      {/if}
      {#if loading}<LoadingIndicator label={copy.loading} size="sm" centered={false} />{/if}
      {#if routes.length}
        <div class="flex flex-wrap items-end justify-between gap-3">
          <div class="w-full space-y-1.5 sm:max-w-sm">
            <label for={pickerId} class="nx-field-label block">{copy.route}</label>
            <BSelect id={pickerId} searchable ariaLabel={copy.route} placeholder={copy.choose} bind:value={pickerValue}
              searchLabels={{ search: copy.search, empty: copy.noMatch }}
              options={routes.map(item => ({ label: item.path, value: item.id }))} disabled={loading || saving} onchange={selectRoute} />
          </div>
          {#if route}
            <StatusBadge variant={route.binding?.enabled ? 'active' : 'muted'}>
              {route.binding ? route.binding.enabled ? copy.ready : copy.off : copy.unbound}
            </StatusBadge>
          {/if}
        </div>
        {#if route}
          {#if writeBlocked}<p role="alert" class="border-l-2 border-amber-500 px-3 py-2 text-sm text-amber-300">{copy.writeBlocked}</p>{/if}
          {#if problem}
            <p role="alert" class="border-l-2 border-red-500 px-3 py-2 text-sm text-red-300">{copy[problem]}</p>
          {/if}
          {#if notice}<p role="status" class="text-sm text-zinc-300">{copy[notice]}</p>{/if}
          <div class="border-t border-carbon-600 pt-4" inert={saving || loading}>
            {#key revision}
              <RedactionRulesEditor value={draft} label={copy.rules} onchange={rules => { draft = rules; notice = null; }}
                onvalidate={value => { invalid = value; }} />
            {/key}
          </div>
          <div class="flex flex-wrap gap-2 border-t border-carbon-600 pt-4">
            {#if problem === 'conflict'}
              <Button variant="outline" disabled={saving || loading} onclick={reload}>{dirty ? copy.reload : copy.reloadClean}</Button>
            {:else}
              <Button disabled={!canSaveRules || saving || loading || writeBlocked}
                onclick={() => commit(false)}>{saving ? copy.saving : !route.binding ? copy.bind : route.binding.enabled ? copy.save : copy.enable}</Button>
              {#if dirty}
                <Button variant="ghost" disabled={saving || loading} onclick={() => openRoute(selected)}>{copy.discard}</Button>
              {/if}
              {#if route.binding}
                <Button variant="destructive" disabled={saving || loading || writeBlocked} onclick={() => commit(true)}>{copy.unbind}</Button>
              {/if}
            {/if}
          </div>
        {/if}
      {:else if !loading && !loadFailed}
        <p class="text-sm text-zinc-400">{copy.noRoutes}</p>
      {/if}
    </div>
  </PanelCard>
</div>
