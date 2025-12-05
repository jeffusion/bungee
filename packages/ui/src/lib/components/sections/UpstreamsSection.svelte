<script lang="ts">
  import type { Route, Upstream } from '../../api/routes';
  import type { ValidationError } from '../../validation';
  import { validateUpstreamSync } from '../../validation';
  import UpstreamForm from '../UpstreamForm.svelte';
  import { _ } from '../../i18n';
  import { v4 as uuidv4 } from 'uuid';

  export let route: Route;
  export let errors: ValidationError[] = [];
  export let weightErrors: ValidationError[] = [];

  let upstreamSearchTerm = '';
  let showUpstreamModal = false;
  let editingUpstreamIndex = -1;
  let editingUpstream: any = null;
  let editingUpstreamErrors: ValidationError[] = [];

  // 就地编辑状态
  let editingIndex = -1;
  let editingField: 'priority' | 'weight' | 'description' | null = null;
  let originalValue: number | string;

  $: filteredUpstreamsWithIndex = route.upstreams
    .map((u, i) => ({ u, i }))
    .filter(({ u }) =>
      !upstreamSearchTerm || u.target.toLowerCase().includes(upstreamSearchTerm.toLowerCase())
    );

  $: if (showUpstreamModal && editingUpstream) {
    editingUpstreamErrors = validateUpstreamSync(editingUpstream, editingUpstreamIndex === -1 ? route.upstreams.length : editingUpstreamIndex);
  }
  $: isEditingUpstreamValid = showUpstreamModal && editingUpstream && editingUpstreamErrors.length === 0;

  // 就地编辑验证
  $: editingFieldErrors = editingIndex >= 0 && editingField
    ? validateUpstreamSync(route.upstreams[editingIndex], editingIndex)
        .filter(e => e.field.includes(editingField))
    : [];

  function openUpstreamModal(index: number = -1) {
    editingUpstreamIndex = index;
    if (index >= 0) {
      editingUpstream = JSON.parse(JSON.stringify(route.upstreams[index]));
    } else {
      editingUpstream = {
        _uid: uuidv4(),
        target: '',
        weight: 100,
        priority: route.upstreams.length + 1,
        headers: { add: {}, remove: [], default: {} },
        body: { add: {}, remove: [], replace: {}, default: {} },
        query: { add: {}, remove: [], replace: {}, default: {} }
      };
    }
    showUpstreamModal = true;
  }

  function closeUpstreamModal() {
    showUpstreamModal = false;
    editingUpstream = null;
  }

  function saveUpstream() {
    if (!isEditingUpstreamValid) return;

    if (editingUpstreamIndex >= 0) {
      route.upstreams[editingUpstreamIndex] = editingUpstream;
    } else {
      route.upstreams = [...route.upstreams, editingUpstream];
    }
    closeUpstreamModal();
  }

  function removeUpstream(index: number) {
    if (route.upstreams.length <= 1) {
      alert($_('routeEditor.upstreamRequired'));
      return;
    }
    route.upstreams = route.upstreams.filter((_, i) => i !== index);
  }

  function duplicateUpstream(index: number) {
    const originalUpstream = route.upstreams[index];
    const duplicatedUpstream = JSON.parse(JSON.stringify(originalUpstream));

    duplicatedUpstream._uid = uuidv4();

    if (duplicatedUpstream.target) {
      const urlMatch = duplicatedUpstream.target.match(/^(.+?)(-\d+)?$/);
      if (urlMatch) {
        const [, baseUrl, suffix] = urlMatch;
        if (suffix) {
          const num = parseInt(suffix.slice(1)) + 1;
          duplicatedUpstream.target = `${baseUrl}-${num}`;
        } else {
          duplicatedUpstream.target = `${baseUrl}-copy`;
        }
      } else {
        duplicatedUpstream.target = `${duplicatedUpstream.target}-copy`;
      }
    }

    if (duplicatedUpstream.priority !== undefined) {
      duplicatedUpstream.priority = Math.max(...route.upstreams.map(u => u.priority || 1)) + 1;
    }

    route.upstreams = [
      ...route.upstreams.slice(0, index + 1),
      duplicatedUpstream,
      ...route.upstreams.slice(index + 1)
    ];
  }

  function toggleUpstreamStatus(index: number) {
    route.upstreams[index].disabled = !route.upstreams[index].disabled;
    route.upstreams = route.upstreams; // 触发 Svelte 响应式更新
  }

  function startEditing(index: number, field: 'priority' | 'weight' | 'description') {
    editingIndex = index;
    editingField = field;
    originalValue = route.upstreams[index][field] || (field === 'priority' ? 1 : field === 'weight' ? 100 : '');
  }

  function saveField() {
    if (editingFieldErrors.length === 0 && editingIndex >= 0 && editingField) {
      // 验证通过，数据已经通过 bind:value 绑定更新，触发响应式
      route.upstreams = route.upstreams;
      editingIndex = -1;
      editingField = null;
    }
    // 如果有错误，保持编辑状态
  }

  function cancelEditing() {
    if (editingIndex >= 0 && editingField) {
      // 恢复原值
      route.upstreams[editingIndex][editingField] = originalValue;
      route.upstreams = route.upstreams;
      editingIndex = -1;
      editingField = null;
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation(); // 阻止事件冒泡到父级表单
      saveField();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation(); // 阻止事件冒泡到父级表单
      cancelEditing();
    }
  }

  // 处理可点击元素的键盘事件（Enter 或 Space 触发点击）
  function handleClickableKeydown(event: KeyboardEvent, callback: () => void) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      callback();
    }
  }
</script>

<div class="space-y-4">
  <div class="flex justify-between items-center">
    <div>
      <h3 class="text-lg font-semibold">
        {$_('routeEditor.upstreams')} <span class="text-error">*</span>
      </h3>
      <p class="text-sm text-gray-500 mt-1">
        {$_('routeEditor.upstreamsHelp')}
      </p>
    </div>
    <div class="flex gap-2">
      <input
        type="text"
        placeholder={$_('common.search')}
        class="input input-bordered input-sm"
        bind:value={upstreamSearchTerm}
      />
      <button
        type="button"
        class="btn btn-sm btn-primary"
        on:click={() => openUpstreamModal(-1)}
      >
        {$_('routeEditor.addUpstream')}
      </button>
    </div>
  </div>

  {#if errors.some(e => e.field === 'upstreams')}
    <div class="alert alert-error">
      <span>{errors.find(e => e.field === 'upstreams')?.message}</span>
    </div>
  {/if}

  <div class="overflow-x-auto">
    <table class="table table-zebra w-full">
      <thead>
        <tr>
          <th class="w-16 text-center">{$_('upstream.status')}</th>
          <th class="w-20">{$_('upstream.priority')}</th>
          <th class="w-20">{$_('upstream.weight')}</th>
          <th>{$_('upstream.target')}</th>
          <th class="w-40">{$_('upstream.description')}</th>
          <th class="w-32">{$_('routes.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {#each filteredUpstreamsWithIndex as { u: upstream, i: index } (upstream._uid)}
          <tr class="hover" class:opacity-50={upstream.disabled}>
            <td class="text-center">
              <input
                type="checkbox"
                class="checkbox checkbox-sm checkbox-success"
                checked={!upstream.disabled}
                on:change={() => toggleUpstreamStatus(index)}
                title={upstream.disabled ? $_('upstream.enableTooltip') : $_('upstream.disableTooltip')}
              />
            </td>
            <td>
              {#if editingIndex === index && editingField === 'priority'}
                <div class="flex items-center gap-1">
                  <input
                    type="number"
                    class="input input-sm input-bordered w-16"
                    class:input-error={editingFieldErrors.length > 0}
                    bind:value={upstream.priority}
                    on:blur={saveField}
                    on:keydown={handleKeydown}
                  />
                  {#if editingFieldErrors.length > 0}
                    <div class="tooltip tooltip-error" data-tip={editingFieldErrors[0].message}>
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-error" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                      </svg>
                    </div>
                  {/if}
                </div>
              {:else}
                <span
                  class="cursor-pointer hover:bg-base-200 px-2 py-1 rounded"
                  on:click={() => startEditing(index, 'priority')}
                  on:keydown={(e) => handleClickableKeydown(e, () => startEditing(index, 'priority'))}
                  role="button"
                  tabindex="0"
                >
                  {upstream.priority || 1}
                </span>
              {/if}
            </td>
            <td>
              {#if editingIndex === index && editingField === 'weight'}
                <div class="flex items-center gap-1">
                  <input
                    type="number"
                    class="input input-sm input-bordered w-16"
                    class:input-error={editingFieldErrors.length > 0}
                    bind:value={upstream.weight}
                    on:blur={saveField}
                    on:keydown={handleKeydown}
                  />
                  {#if editingFieldErrors.length > 0}
                    <div class="tooltip tooltip-error" data-tip={editingFieldErrors[0].message}>
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-error" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                      </svg>
                    </div>
                  {/if}
                </div>
              {:else}
                <span
                  class="cursor-pointer hover:bg-base-200 px-2 py-1 rounded"
                  on:click={() => startEditing(index, 'weight')}
                  on:keydown={(e) => handleClickableKeydown(e, () => startEditing(index, 'weight'))}
                  role="button"
                  tabindex="0"
                >
                  {upstream.weight || 100}
                </span>
              {/if}
            </td>
            <td>
              <div class="flex flex-col">
                <div class="font-bold truncate max-w-xs" title={upstream.target}>{upstream.target}</div>
                {#if upstream.plugins && upstream.plugins.length > 0}
                  <span class="badge badge-sm badge-info mt-1">Transformer</span>
                {/if}
              </div>
            </td>
            <td>
              {#if editingIndex === index && editingField === 'description'}
                <div class="flex items-center gap-1">
                  <input
                    type="text"
                    class="input input-sm input-bordered w-full"
                    bind:value={upstream.description}
                    on:blur={saveField}
                    on:keydown={handleKeydown}
                    placeholder={$_('upstream.descriptionPlaceholder')}
                  />
                </div>
              {:else}
                {#if upstream.description}
                  <span
                    class="text-sm text-gray-600 truncate block cursor-pointer hover:bg-base-200 px-2 py-1 rounded"
                    title={upstream.description}
                    on:click={() => startEditing(index, 'description')}
                    on:keydown={(e) => handleClickableKeydown(e, () => startEditing(index, 'description'))}
                    role="button"
                    tabindex="0"
                  >
                    {upstream.description}
                  </span>
                {:else}
                  <span
                    class="text-sm text-gray-400 cursor-pointer hover:bg-base-200 px-2 py-1 rounded"
                    on:click={() => startEditing(index, 'description')}
                    on:keydown={(e) => handleClickableKeydown(e, () => startEditing(index, 'description'))}
                    role="button"
                    tabindex="0"
                  >
                    -
                  </span>
                {/if}
              {/if}
            </td>
            <td>
              <div class="flex gap-1">
                <button type="button" class="btn btn-square btn-xs" title={$_('common.edit')} on:click={() => openUpstreamModal(index)}>
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                </button>
                <button type="button" class="btn btn-square btn-xs" title={$_('routeCard.duplicate')} on:click={() => duplicateUpstream(index)}>
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                </button>
                <button type="button" class="btn btn-square btn-xs btn-error" title={$_('common.delete')} on:click={() => removeUpstream(index)}>
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </td>
          </tr>
        {/each}
        {#if filteredUpstreamsWithIndex.length === 0}
          <tr>
            <td colspan="6" class="text-center text-gray-500 py-8">
              {upstreamSearchTerm ? $_('routes.noMatchingRoutes') : $_('routes.noRoutesMessage')}
            </td>
          </tr>
        {/if}
      </tbody>
    </table>
  </div>

  {#if weightErrors.length > 0}
    <div class="alert alert-warning">
      <span>{weightErrors[0].message}</span>
    </div>
  {/if}
</div>

<!-- Upstream Edit Modal -->
{#if showUpstreamModal && editingUpstream}
  <div class="modal modal-open">
    <div class="modal-box w-11/12 max-w-3xl">
      <h3 class="font-bold text-lg mb-4">
        {editingUpstreamIndex >= 0 ? $_('upstream.title', { values: { index: editingUpstreamIndex + 1 } }) : $_('routeEditor.addUpstream')}
      </h3>

      <div class="max-h-[70vh] overflow-y-auto">
        <UpstreamForm
          bind:upstream={editingUpstream}
          index={editingUpstreamIndex}
          showHeader={false}
          onRemove={() => {}}
          onDuplicate={() => {}}
        />
      </div>

      <div class="modal-action">
        <button type="button" class="btn" on:click={closeUpstreamModal}>{$_('common.cancel')}</button>
        <button type="button" class="btn btn-primary" on:click={saveUpstream} disabled={!isEditingUpstreamValid}>
          {$_('common.save')}
        </button>
      </div>
    </div>
  </div>
{/if}
