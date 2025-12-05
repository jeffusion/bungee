<script lang="ts">
  import type { Route, Upstream } from '../api/routes';
  import type { ValidationError } from '../validation';
  import { validateUpstreamSync } from '../validation';
  import { RoutesAPI } from '../api/routes';
  import { toast } from '../stores/toast';
  import { _ } from '../i18n';

  export let open = false;
  export let route: Route;
  export let onSaved: (() => void) | undefined = undefined;

  // 克隆数据用于编辑
  let editingUpstreams: Upstream[] = [];
  let wasOpen = false;

  // 就地编辑状态
  let editingIndex = -1;
  let editingField: 'priority' | 'weight' | 'description' | null = null;
  let originalValue: number | string;
  let saving = false;

  // 响应式语句
  // 1. 弹窗打开时克隆数据（只执行一次）
  $: {
    if (open && !wasOpen) {
      editingUpstreams = JSON.parse(JSON.stringify(route.upstreams));
    }
    wasOpen = open;
  }

  // 2. 自动检测是否有修改
  $: hasChanges = JSON.stringify(editingUpstreams) !== JSON.stringify(route.upstreams);

  // 3. 就地编辑的验证
  $: editingFieldErrors = editingIndex >= 0 && editingField
    ? validateUpstreamSync(editingUpstreams[editingIndex], editingIndex)
        .filter(e => e.field.includes(editingField))
    : [];

  async function closeModal() {
    // 1. 如果正在编辑某个字段，先处理编辑状态
    if (editingIndex >= 0 && editingField) {
      if (editingFieldErrors.length > 0) {
        // 有错误，取消编辑
        cancelEditing();
      } else {
        // 没有错误，完成编辑
        editingIndex = -1;
        editingField = null;
      }
    }

    // 2. 如果有修改，自动保存
    if (hasChanges) {
      // 验证所有上游
      const allErrors = validateAllUpstreams();
      if (allErrors.length > 0) {
        toast.show($_('upstreamsModal.validationFailed'), 'error');
        return; // 不关闭弹窗
      }

      // 保存到后端
      const saved = await saveToBackend();
      if (!saved) {
        return; // 保存失败，不关闭弹窗
      }
    }

    // 3. 关闭弹窗并重置状态
    open = false;
    editingIndex = -1;
    editingField = null;
  }

  function getUpstreamStatus(upstream: Upstream): 'healthy' | 'unhealthy' | 'unknown' {
    if (!upstream.status) {
      return 'unknown';
    }
    return upstream.status === 'HEALTHY' ? 'healthy' : 'unhealthy';
  }

  function formatLastFailureTime(timestamp: number | undefined): string {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);

    if (diffSec < 60) return `${diffSec}秒前`;
    if (diffMin < 60) return `${diffMin}分钟前`;
    if (diffHour < 24) return `${diffHour}小时前`;
    return date.toLocaleString('zh-CN');
  }

  // 切换启用/禁用状态
  function toggleUpstreamStatus(index: number) {
    editingUpstreams[index].disabled = !editingUpstreams[index].disabled;
    editingUpstreams = editingUpstreams;
    // 移除即时保存
  }

  // 开始编辑字段
  function startEditing(index: number, field: 'priority' | 'weight' | 'description') {
    editingIndex = index;
    editingField = field;
    originalValue = editingUpstreams[index][field] || (field === 'priority' ? 1 : field === 'weight' ? 100 : '');
  }

  // 保存字段
  function saveField() {
    if (editingFieldErrors.length === 0 && editingIndex >= 0 && editingField) {
      // 移除即时保存，只退出编辑模式
      editingIndex = -1;
      editingField = null;
    }
    // 如果有错误，保持编辑状态
  }

  // 取消编辑
  function cancelEditing() {
    if (editingIndex >= 0 && editingField) {
      editingUpstreams[editingIndex][editingField] = originalValue;
      editingUpstreams = editingUpstreams;
      editingIndex = -1;
      editingField = null;
    }
  }

  // 键盘事件处理（就地编辑）
  function handleInputKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      saveField();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
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

  // 保存到后端
  async function saveToBackend(): Promise<boolean> {
    if (saving) return false;  // 防止重复保存

    saving = true;
    try {
      // 构造完整的 route 对象，剔除 _uid, status, lastFailureTime
      const updatedRoute = {
        ...route,
        upstreams: editingUpstreams.map(({ _uid, status, lastFailureTime, ...upstream }) => upstream)
      };

      await RoutesAPI.update(route.path, updatedRoute);
      toast.show($_('upstreamsModal.saved'), 'success');

      // 通知父组件刷新（可选）
      onSaved?.();
      return true; // 保存成功
    } catch (e: any) {
      toast.show($_('upstreamsModal.saveFailed', { values: { error: e.message } }), 'error');
      return false; // 保存失败
    } finally {
      saving = false;
    }
  }

  // 验证所有上游
  function validateAllUpstreams(): ValidationError[] {
    let allErrors: ValidationError[] = [];
    editingUpstreams.forEach((upstream, index) => {
      const errors = validateUpstreamSync(upstream, index);
      allErrors.push(...errors);
    });
    return allErrors;
  }

  // Handle ESC key
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      // 如果正在编辑，先取消编辑
      if (editingIndex >= 0 && editingField) {
        cancelEditing();
      } else {
        // 否则关闭弹窗（自动保存）
        closeModal();
      }
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<dialog class="modal" class:modal-open={open}>
  <div class="modal-box max-w-4xl">
    <h3 class="font-bold text-lg mb-4">
      {$_('upstreamsModal.title')} - <code class="text-primary">{route.path}</code>
    </h3>

    <div class="overflow-x-auto max-h-[60vh]">
      <table class="table table-zebra w-full">
        <thead>
          <tr>
            <th class="w-20">{$_('routeCard.tableHeaders.status')}</th>
            <th class="w-16 text-center">{$_('upstream.status')}</th>
            <th>{$_('upstream.target')}</th>
            <th class="w-40">{$_('upstream.description')}</th>
            <th class="w-20 text-right">{$_('upstream.priority')}</th>
            <th class="w-24 text-right">{$_('upstream.weight')}</th>
          </tr>
        </thead>
        <tbody>
          {#each editingUpstreams as upstream, index (upstream._uid || index)}
            <tr class="hover" class:opacity-50={upstream.disabled || saving}>
              <!-- 健康状态列 -->
              <td>
                <div class="flex items-center gap-2">
                  <div
                    class="w-3 h-3 rounded-full tooltip tooltip-right"
                    class:bg-success={getUpstreamStatus(upstream) === 'healthy' && !upstream.disabled}
                    class:bg-error={getUpstreamStatus(upstream) === 'unhealthy' && !upstream.disabled}
                    class:bg-warning={getUpstreamStatus(upstream) === 'unknown' && !upstream.disabled}
                    class:bg-gray-400={upstream.disabled}
                    data-tip={upstream.disabled
                      ? $_('upstream.disabled')
                      : upstream.lastFailureTime
                        ? `最后失败: ${formatLastFailureTime(upstream.lastFailureTime)}`
                        : getUpstreamStatus(upstream) === 'healthy'
                          ? $_('upstreamsModal.statusHealthy')
                          : getUpstreamStatus(upstream) === 'unhealthy'
                            ? $_('upstreamsModal.statusUnhealthy')
                            : $_('upstreamsModal.statusUnknown')}
                  ></div>
                  {#if getUpstreamStatus(upstream) === 'unhealthy' && !upstream.disabled}
                    <span class="text-xs text-error font-semibold">RED</span>
                  {/if}
                </div>
              </td>

              <!-- 启用 checkbox 列 -->
              <td class="text-center">
                <input
                  type="checkbox"
                  class="checkbox checkbox-sm checkbox-success"
                  checked={!upstream.disabled}
                  on:change={() => toggleUpstreamStatus(index)}
                  disabled={saving}
                  title={upstream.disabled ? $_('upstream.enableTooltip') : $_('upstream.disableTooltip')}
                />
              </td>

              <!-- 目标列 -->
              <td>
                <code class="text-sm">{upstream.target}</code>
              </td>

              <td>
                {#if editingIndex === index && editingField === 'description'}
                  <div class="flex items-center gap-1">
                    <input
                      type="text"
                      class="input input-sm input-bordered w-full"
                      bind:value={upstream.description}
                      on:blur={saveField}
                      on:keydown={handleInputKeydown}
                      disabled={saving}
                      placeholder={$_('upstream.descriptionPlaceholder')}
                    />
                  </div>
                {:else}
                  {#if upstream.description}
                    <span
                      class="text-xs text-gray-500 truncate block cursor-pointer hover:bg-base-200 px-2 py-1 rounded"
                      class:pointer-events-none={saving}
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
                      class="text-xs text-gray-400 cursor-pointer hover:bg-base-200 px-2 py-1 rounded"
                      class:pointer-events-none={saving}
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

              <!-- 优先级列（可编辑）-->
              <td class="text-right">
                {#if editingIndex === index && editingField === 'priority'}
                  <div class="flex items-center justify-end gap-1">
                    <input
                      type="number"
                      class="input input-sm input-bordered w-16 text-right"
                      class:input-error={editingFieldErrors.length > 0}
                      bind:value={upstream.priority}
                      on:blur={saveField}
                      on:keydown={handleInputKeydown}
                      disabled={saving}
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
                    class:pointer-events-none={saving}
                    on:click={() => startEditing(index, 'priority')}
                    on:keydown={(e) => handleClickableKeydown(e, () => startEditing(index, 'priority'))}
                    role="button"
                    tabindex="0"
                  >
                    {upstream.priority || 1}
                  </span>
                {/if}
              </td>

              <!-- 权重列（可编辑）-->
              <td class="text-right">
                {#if editingIndex === index && editingField === 'weight'}
                  <div class="flex items-center justify-end gap-1">
                    <input
                      type="number"
                      class="input input-sm input-bordered w-16 text-right"
                      class:input-error={editingFieldErrors.length > 0}
                      bind:value={upstream.weight}
                      on:blur={saveField}
                      on:keydown={handleInputKeydown}
                      disabled={saving}
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
                    class:pointer-events-none={saving}
                    on:click={() => startEditing(index, 'weight')}
                    on:keydown={(e) => handleClickableKeydown(e, () => startEditing(index, 'weight'))}
                    role="button"
                    tabindex="0"
                  >
                    {upstream.weight || 100}
                  </span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- 保存状态提示 -->
    {#if saving}
      <div class="alert alert-info mt-2">
        <span class="loading loading-spinner loading-sm"></span>
        <span>{$_('upstreamsModal.saving')}</span>
      </div>
    {/if}

    <div class="modal-action">
      <button
        class="btn"
        on:click={closeModal}
        disabled={saving}
      >
        {#if saving}
          <span class="loading loading-spinner loading-sm"></span>
        {/if}
        {$_('upstreamsModal.close')}
      </button>
    </div>
  </div>
  <form method="dialog" class="modal-backdrop">
    <button on:click={closeModal}>close</button>
  </form>
</dialog>
