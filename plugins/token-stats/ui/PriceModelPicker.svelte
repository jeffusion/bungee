<script lang="ts">
  import { onMount } from 'svelte';
  import { requestPluginControl } from '@bungee/plugin-sdk';
  import { BSelect } from '$components/industrial';
  import { createPricingModelSearch, type PricingModelSearchState } from './pricing-catalog';

  let { provider, catalogVersion, value, disabled = false, label, placeholder, searchLabel, emptyLabel,
    loadingLabel, errorLabel, retryLabel, loadedLabel, completeLabel, loadMoreLabel, onchange,
    catalogPlugin = 'token-stats', catalogPath = '/pricing/models' }: {
    provider: string; catalogVersion: number | null; value: string; disabled?: boolean;
    label: string; placeholder: string; searchLabel: string; emptyLabel: string;
    loadingLabel: string; errorLabel: string; retryLabel: string;
    loadedLabel: string; completeLabel: string; loadMoreLabel: string; onchange: (model: string) => void;
    catalogPlugin?: string; catalogPath?: string;
  } = $props();
  let results = $state<PricingModelSearchState>({ models: [], total: 0, page: 1, pageSize: 50, loading: false, error: false });
  const modelSearch = createPricingModelSearch(
    (path, signal) => requestPluginControl(catalogPlugin, path, 'GET', undefined, signal),
    state => { results = state; }, 250, catalogPath,
  );
  const options = $derived(results.models.map(model => ({ value: model.model, label: model.model })));
  onMount(() => () => modelSearch.destroy());
</script>

<BSelect {value} {options} disabled={disabled || !provider} ariaLabel={label} {placeholder}
  rootTestId="price-model-picker"
  searchLabels={{ search: searchLabel, loading: loadingLabel, error: errorLabel, empty: emptyLabel,
    retry: retryLabel, loaded: loadedLabel, complete: completeLabel, loadMore: loadMoreLabel }}
  remoteSearch={{ result: results, resetKey: JSON.stringify([provider, catalogVersion]),
    search: (search, page, debounce) => modelSearch.search({ provider, search }, page, debounce), cancel: () => modelSearch.cancel() }}
  onchange={next => onchange(String(next))} />
