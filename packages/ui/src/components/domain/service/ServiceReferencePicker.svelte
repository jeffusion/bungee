<script lang="ts">
  import type { Service } from '$api/routes';
  import { _ } from '$i18n';
  import { BSelect } from '$components/industrial';
  let { value = $bindable(''), services, excludedIds = [], ownerId }: {
    value?: string; services: Service[]; excludedIds?: string[]; ownerId?: string;
  } = $props();
</script>

<div class="space-y-2" data-testid="service-reference-picker">
  <span class="nx-field-label">{$_('routeEditor.selectServiceTitle')}</span>
  <BSelect searchable bind:value ariaLabel={$_('routeEditor.selectServiceTitle')} placeholder={$_('routeEditor.selectServiceTitle')}
    searchLabels={{ search: $_('common.search'), empty: $_('common.noMatches') }}
    options={services.filter(service => service._uid && service._uid !== ownerId && !excludedIds.includes(service._uid)).map(service => ({ value: service._uid!, label: service.name }))} />
</div>
