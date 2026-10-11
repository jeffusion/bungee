<script lang="ts">
  import BasicInfoSection from '$components/domain/route/sections/BasicInfoSection.svelte';
  import FailoverEditor from '$components/domain/service/FailoverEditor.svelte';
  import type { Route, FailoverConfig } from '$types';
  import BSelect from '$components/industrial/BSelect.svelte';
  import PluginEditor from '$components/domain/plugin/PluginEditor.svelte';
  import UpstreamsSection from '$components/domain/route/sections/UpstreamsSection.svelte';
  import KeyPolicy from '@plugins/key-access/ui/KeyPolicy.svelte';
  import DesignSystem from '$lib/routes/DesignSystem.svelte';
  import RouteEditor from '$lib/routes/RouteEditor.svelte';
  import ServiceEditor from '$lib/routes/ServiceEditor.svelte';
  import type { EditorPluginBinding } from '$api/config-adapters';
  const params = new URLSearchParams(location.search);
  const scenario = params.get('scenario');
  const mode = params.get('mode') as 'single' | 'multiple' | 'tags' || 'single';
  const options = [{ value: '', label: 'All types' }, { value: 'final', label: 'Final' }];
  let value = $state(params.get('value') ?? '');
  let values = $state(['', 'final']);
  let calls = $state<(string | string[])[]>([]);
  let plugins = $state<EditorPluginBinding[]>([{ _uid: 'owner', _position: 4, name: 'fixture-plugin', enabled: false,
    options: { accountRef: 'account', unknown: { nested: [1, 2] }, visible: 'before' } }]);
  let route = $state({ endpoints: [
    { _uid: 'hidden', target: 'https://hidden.test', description: 'private', priority: 1, weight: 100 },
    { _uid: 'visible', target: 'https://ALPHA.test', description: 'Primary Pool', priority: 5, weight: 20 },
    { _uid: 'other', target: 'https://other.test', description: 'Backup Pool', priority: 9, weight: 30 },
  ] });
  let rewriteRoute = $state<Route>({ path: '/before', plugins: [], path_rewrite: { '^/before': '/after' } });
  let failover = $state<FailoverConfig | undefined>({ enabled: true, retry_on_response: ['before'] });
</script>
<main class="nx-page py-6">
{#if scenario === 'select'}
  <BSelect options={params.has('placeholder') ? options.slice(1) : options} {mode}
    bind:value bind:values allowClear autoWidth={params.has('autoWidth')} ariaLabel="Selection" placeholder="Choose a type"
    onchange={next => calls.push(JSON.parse(JSON.stringify(next)))} />
  <output data-testid="selection">{JSON.stringify({ value, values, calls })}</output>
{:else if scenario === 'plugin'}
  <PluginEditor bind:plugins protectedBindingIds={params.has('protected') ? ['owner'] : []} />
  <output data-testid="plugins">{JSON.stringify(plugins)}</output>
{:else if scenario === 'upstreams'}
  <UpstreamsSection bind:route isService />
  <output data-testid="endpoints">{JSON.stringify(route.endpoints)}</output>
{:else if scenario === 'rewrite'}
  <BasicInfoSection bind:route={rewriteRoute} showOnly="path" />
  <BasicInfoSection bind:route={rewriteRoute} showOnly="rewrite" />
  <output data-testid="rewrite-model">{JSON.stringify(rewriteRoute)}</output>
{:else if scenario === 'failover'}
  <FailoverEditor bind:failover />
  <output data-testid="failover-model">{JSON.stringify(failover)}</output>
{:else if scenario === 'keys'}
  <KeyPolicy />
{:else if scenario === 'design'}
  <DesignSystem />
{:else if scenario === 'route'}
  <RouteEditor params={params.has('edit') ? { path: '%2Floaded' } : {}} />
{:else if scenario === 'service'}
  <ServiceEditor params={params.has('edit') ? { name: 'existing' } : {}} />
{/if}
</main>
