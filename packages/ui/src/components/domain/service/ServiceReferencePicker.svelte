<script lang="ts">
  import type { Service, Route } from '$api/routes';
  import { v4 as uuidv4 } from 'uuid';
  import { _ } from '$i18n';
  import { BSelect } from '$components/industrial';
  import { Button } from '$components/ui/button';
  let { owner = $bindable(), services, ownerId }: {
    owner: Pick<Route, 'service_references' | 'endpoints'>; services: Service[]; ownerId?: string;
  } = $props();
  let open = $state(false);
  function add(serviceId: string) {
    if (!serviceId) return;
    const positions = [...(owner.endpoints ?? []).map((endpoint, index) => endpoint._position ?? index), ...(owner.service_references ?? []).map(reference => reference.position)];
    owner.service_references = [...(owner.service_references ?? []), { id: uuidv4(), service_id: serviceId,
      position: Math.max(-1, ...positions) + 1, priority: 1, weight: 100, is_disabled: false }];
    open = false;
  }
</script>
<div class="flex gap-2 items-center flex-wrap" data-testid="service-reference-picker">
  <Button variant="outline" size="sm" onclick={() => open = !open}>{$_('serviceReferences.add')}</Button>
  {#if open}
    <div class="min-w-48 flex-1">
      <BSelect searchable ariaLabel={$_('routeEditor.selectServiceTitle')} placeholder={$_('routeEditor.selectServiceTitle')}
        options={services.filter(service => service._uid && service._uid !== ownerId && !owner.service_references?.some(reference => reference.service_id === service._uid)).map(service => ({ value: service._uid!, label: service.name }))}
        onchange={value => add(String(value))} />
    </div>
  {/if}
</div>
