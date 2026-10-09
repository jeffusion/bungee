<script lang="ts">
  import { onMount } from 'svelte';
  import BSelect from './BSelect.svelte';
  import { createModelSearch, type ModelSearchState } from './paginated-search';
  let value = $state('item-075');
  let result = $state<ModelSearchState<string>>({ models: [], total: 0, page: 1, pageSize: 50, loading: false, error: false });
  const source = Array.from({ length: 123 }, (_, index) => `item-${String(index + 1).padStart(3, '0')}`);
  const search = createModelSearch(async (path, signal) => {
    const params = new URLSearchParams(path);
    const keyword = params.get('search') ?? '', page = Number(params.get('page') ?? 1);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 150);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true });
    });
    const matches = source.filter(item => item.includes(keyword));
    return { models: matches.slice((page - 1) * 50, page * 50), total: matches.length, page, pageSize: 50 };
  }, next => { result = next; }, (keyword: string, page) => new URLSearchParams({ search: keyword, page: String(page) }).toString());
  const options = $derived(result.models.map(item => ({ value: item, label: item })));
  onMount(() => () => search.destroy());
</script>

<div class="max-w-sm space-y-3" data-testid="design-search-select">
  <BSelect {value} {options} ariaLabel="搜索选择 / Search selection" placeholder="选择项目 / Select item"
    searchLabels={{ search: '搜索项目 / Search items', loading: '正在加载 / Loading', error: '加载失败 / Failed',
      empty: '无匹配项 / No matches', retry: '重试 / Retry', loaded: '已加载 / Loaded', complete: '已全部加载 / All loaded', loadMore: '加载更多 / Load more' }}
    remoteSearch={{ result, search: (keyword, page, debounce) => search.search(keyword, page, debounce), cancel: () => search.cancel() }}
    onchange={next => value = String(next)} />
  <p class="text-sm text-zinc-400">在字段内搜索，滚动加载更多。方向键选择，Enter 确认，Escape 恢复已选值。</p>
</div>

<div class="mt-4 max-w-sm space-y-3" data-testid="design-local-search-select">
  <BSelect searchable ariaLabel="本地搜索选择 / Local search selection" options={[{ value: 'local-a', label: 'Local A' }, { value: 'local-b', label: 'Local B' }, { value: 'local-disabled', label: 'Local disabled', disabled: true }]} placeholder="本地过滤 / Local filter" />
  <BSelect creatable allowClear ariaLabel="自定义选择 / Custom selection" options={[{ value: 'preset', label: 'Preset' }]} placeholder="输入标识 / Enter ID" />
</div>
