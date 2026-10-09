<script lang="ts">
  import { onMount } from 'svelte';
  import { requestPluginControl } from '@bungee/plugin-sdk';
  import { BSelect } from '$components/industrial';
  import { createClientModelSearch, type ClientModelSearchState } from './client-model-search';

  let { id, value, disabled = false, label, placeholder, searchLabel, loadingLabel, errorLabel,
    emptyLabel, retryLabel, customLabel, loadedLabel, completeLabel, loadMoreLabel, onchange }: {
    id: string; value: string; disabled?: boolean; label: string; placeholder: string;
    searchLabel: string; loadingLabel: string; errorLabel: string; emptyLabel: string;
    retryLabel: string; customLabel: string; loadedLabel: string; completeLabel: string; loadMoreLabel: string;
    onchange: (value: string) => void;
  } = $props();
  let results = $state<ClientModelSearchState>({ models: [], total: 0, page: 1, pageSize: 50, loading: false, error: false });
  const search = createClientModelSearch(
    (path, signal) => requestPluginControl('token-stats', path, 'GET', undefined, signal),
    state => { results = state; },
  );
  const options = $derived(results.models.map(model => ({ value: model, label: model })));
  onMount(() => () => search.destroy());
</script>

<BSelect {id} {value} {options} {disabled} ariaLabel={label} {placeholder} creatable maxLength={256}
  rootTestId="client-model-picker" searchTestId="client-model-input"
  searchLabels={{ search: searchLabel, loading: loadingLabel, error: errorLabel, empty: emptyLabel,
    retry: retryLabel, custom: customLabel, loaded: loadedLabel, complete: completeLabel, loadMore: loadMoreLabel }}
  remoteSearch={{ result: results, search: (keyword, page, debounce) => search.search(keyword, page, debounce), cancel: () => search.cancel() }}
  onchange={next => onchange(String(next))} />
