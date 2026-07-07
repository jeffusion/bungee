<script lang="ts">
  import type { LoadBalancingConfig } from '$types';
  import { BSelect } from '$components/industrial';
  import { Input } from '$components/ui/input';
  import { _ } from '$i18n';

  export let load_balancing: LoadBalancingConfig | undefined;

  let policy: LoadBalancingConfig['policy'] = 'weighted_random';
  let hashHeader: string = '';
  let hashExpression: string = '';
  let initialized = false;

  function initializeFromProps() {
    policy = load_balancing?.policy ?? 'weighted_random';
    hashHeader = load_balancing?.hash_policy?.header ?? '';
    hashExpression = load_balancing?.hash_policy?.expression ?? '';
  }

  function syncModel() {
    const hp: { header?: string; expression?: string } = {};
    if (hashHeader.trim()) hp.header = hashHeader.trim();
    if (hashExpression.trim()) hp.expression = hashExpression.trim();
    load_balancing = {
      policy,
      ...(Object.keys(hp).length > 0 ? { hash_policy: hp } : {}),
    };
  }

  $: if (!initialized) {
    initializeFromProps();
    initialized = true;
  }
</script>

<div class="space-y-4" data-testid="service-load-balancing-section">
  <div class="flex items-center gap-2">
    <svg viewBox="0 0 24 24" class="h-4 w-4 text-nexus-400" fill="none" stroke="currentColor" stroke-width="1.8">
      <path stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M4 12h10M4 17h7" />
    </svg>
    <span class="font-mono text-[11px] uppercase tracking-command text-zinc-200">{$_('serviceEditor.loadBalancing.title')}</span>
  </div>

  <p class="text-xs text-zinc-500">{$_('serviceEditor.loadBalancing.help')}</p>

  <div class="space-y-3">
    <div class="space-y-1.5">
      <label class="block" for="service-lb-policy">
        <span class="nx-label-sm">{$_('serviceEditor.loadBalancing.policy')}</span>
      </label>
      <BSelect
        id="service-lb-policy"
        value={policy}
        options={[
          { value: 'weighted_random', label: $_('serviceEditor.loadBalancing.policies.weighted_random') },
          { value: 'round_robin', label: $_('serviceEditor.loadBalancing.policies.round_robin') },
          { value: 'least_requests', label: $_('serviceEditor.loadBalancing.policies.least_requests') },
          { value: 'consistent_hash', label: $_('serviceEditor.loadBalancing.policies.consistent_hash') },
        ]}
        onchange={(v) => { policy = v as LoadBalancingConfig['policy']; syncModel(); }}
      />
    </div>

    {#if policy === 'consistent_hash'}
      <div class="space-y-1.5">
        <label class="block" for="service-lb-hash-header">
          <span class="nx-label-sm">{$_('serviceEditor.loadBalancing.hashHeader')}</span>
        </label>
        <Input
          id="service-lb-hash-header"
          type="text"
          placeholder="x-session-id"
          value={hashHeader}
          oninput={(e) => { hashHeader = (e.target as HTMLInputElement).value; syncModel(); }}
        />
        <span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('serviceEditor.loadBalancing.hashHeaderHelp')}</span>
      </div>

      <div class="space-y-1.5">
        <label class="block" for="service-lb-hash-expr">
          <span class="nx-label-sm">{$_('serviceEditor.loadBalancing.hashExpression')}</span>
        </label>
        <Input
          id="service-lb-hash-expr"
          type="text"
          placeholder={`{{ headers['x-user-id'] }}`}
          value={hashExpression}
          oninput={(e) => { hashExpression = (e.target as HTMLInputElement).value; syncModel(); }}
        />
        <span class="font-mono text-[11px] uppercase tracking-command text-zinc-500">{$_('serviceEditor.loadBalancing.hashExpressionHelp')}</span>
      </div>
    {/if}
  </div>
</div>
