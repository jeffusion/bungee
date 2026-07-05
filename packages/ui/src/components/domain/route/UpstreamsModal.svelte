<script lang="ts">
  import type { Route, Upstream } from '$api/routes';
  import type { ValidationError } from '$validation';
  import { validateUpstreamSync } from '$validation';
  import { RoutesAPI } from '$api/routes';
  import { toast } from '$stores/toast';
  import { _ } from '$i18n';
  import { LoadingIndicator } from '$components/industrial';
  import { Input } from '$components/ui/input';
  import { Button } from '$components/ui/button';

  export let open = false;
  export let route: Route;
  export let endpoints: Upstream[] = [];
  export let readOnly = false;
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
      editingUpstreams = JSON.parse(JSON.stringify(endpoints));
    }
    wasOpen = open;
  }

  // 2. 自动检测是否有修改
  $: hasChanges = !readOnly && JSON.stringify(editingUpstreams) !== JSON.stringify(route.endpoints ?? []);

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

  function getUpstreamStatus(upstream: Upstream): 'healthy' | 'unhealthy' | 'half_open' {
    if (!upstream.status || upstream.status === 'HEALTHY') {
      return 'healthy';
    }
    return upstream.status === 'HALF_OPEN' ? 'half_open' : 'unhealthy';
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
  async function toggleUpstreamStatus(index: number) {
    if (readOnly) return;
    editingUpstreams[index].is_disabled = !editingUpstreams[index].is_disabled;
    editingUpstreams = editingUpstreams;
    
    // 立即保存更改
    await saveToBackend();
    
    // saveToBackend 已经显示了 toast，这里不重复显示 enable/disable 状态消息
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
      // 构造完整的 route 对象，剔除 _uid, status, last_failure_time
      const updatedRoute = {
        ...route,
        endpoints: editingUpstreams.map(({ _uid, status, last_failure_time, ...upstream }) => upstream)
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

<dialog class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" class:hidden={!open}>
  <div class="nx-panel-raised nx-bracketed relative w-full max-w-4xl flex flex-col max-h-[90vh]">
    <h3 class="font-bold text-lg mb-4">
      {$_('upstreamsModal.title')} - <code class="text-nexus-300">{route.path}</code>
    </h3>

    <div class="overflow-x-auto max-h-[60vh]">
      <table class="w-full">
        <thead>
          <tr>
            <th class="w-24">{$_('routeCard.tableHeaders.status')}</th>
            <th>{$_('upstream.target')}</th>
            <th class="w-40">{$_('upstream.description')}</th>
            <th class="w-20 text-right">{$_('upstream.priority')}</th>
            <th class="w-24 text-right">{$_('upstream.weight')}</th>
            <th class="w-24 text-center">{$_('routes.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {#each editingUpstreams as upstream, index (upstream._uid || index)}
            <tr class="transition-colors hover:bg-carbon-700/40" class:opacity-50={upstream.is_disabled || saving}>
              <!-- 健康状态列 -->
              <td>
                <div class="flex items-center gap-2">
                  {#if upstream.is_disabled}
                    <span class="nx-badge-fault">{$_('routeEditor.upstreamDisabled')}</span>
                  {:else}
                    <div
                      class="w-3 h-3 rounded-full"
                      class:bg-emerald-500={getUpstreamStatus(upstream) === 'healthy'}
                      class:bg-red-500={getUpstreamStatus(upstream) === 'unhealthy'}
                      class:bg-amber-500={getUpstreamStatus(upstream) === 'half_open'}
                      data-tip={upstream.last_failure_time
                        ? `最后失败: ${formatLastFailureTime(upstream.last_failure_time)}`
                        : getUpstreamStatus(upstream) === 'healthy'
                          ? $_('upstreamsModal.statusHealthy')
                        : getUpstreamStatus(upstream) === 'unhealthy'
                          ? $_('upstreamsModal.statusUnhealthy')
                            : $_('upstreamsModal.statusHalfOpen')}
                    ></div>
                    <span class="text-sm">{$_('routeEditor.upstreamEnabled')}</span>
                  {/if}
                </div>
              </td>

              <!-- 目标列 -->
              <td>
                <code class="text-sm">{upstream.target}</code>
              </td>

              <td>
                {#if editingIndex === index && editingField === 'description'}
                  <div class="flex items-center gap-1">
                    <Input
                      type="text"
                      value={upstream.description ?? ''}
                      oninput={(e) => { upstream.description = (e.target as HTMLInputElement).value; }}
                      onblur={saveField}
                      onkeydown={handleInputKeydown}
                      disabled={saving}
                      placeholder={$_('upstream.descriptionPlaceholder')}
                    />
                  </div>
                {:else}
                  {#if upstream.description}
                    <span
                      class="text-xs text-zinc-500 truncate block cursor-pointer hover:bg-carbon-950/60 px-2 py-1 rounded"
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
                      class="text-xs text-zinc-500 cursor-pointer hover:bg-carbon-950/60 px-2 py-1 rounded"
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
                    <div class:border-red-500={editingFieldErrors.length > 0}>
                      <Input
                        type="number"
                        class="w-16 text-right"
                        value={upstream.priority ?? ''}
                        oninput={(e) => { upstream.priority = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; }}
                        onblur={saveField}
                        onkeydown={handleInputKeydown}
                        disabled={saving}
                      />
                    </div>
                    {#if editingFieldErrors.length > 0}
                      <div title={editingFieldErrors[0].message}>
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-red-300" viewBox="0 0 20 20" fill="currentColor">
                          <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                        </svg>
                      </div>
                    {/if}
                  </div>
                {:else}
                  <span
                    class="cursor-pointer hover:bg-carbon-950/60 px-2 py-1 rounded"
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
                    <div class:border-red-500={editingFieldErrors.length > 0}>
                      <Input
                        type="number"
                        class="w-16 text-right"
                        value={upstream.weight ?? ''}
                        oninput={(e) => { upstream.weight = (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : undefined; }}
                        onblur={saveField}
                        onkeydown={handleInputKeydown}
                        disabled={saving}
                      />
                    </div>
                    {#if editingFieldErrors.length > 0}
                      <div title={editingFieldErrors[0].message}>
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-red-300" viewBox="0 0 20 20" fill="currentColor">
                          <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                        </svg>
                      </div>
                    {/if}
                  </div>
                {:else}
                  <span
                    class="cursor-pointer hover:bg-carbon-950/60 px-2 py-1 rounded"
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

              <!-- Actions 列 -->
              <td class="text-center">
                 {#if upstream.is_disabled}
                   <Button size="sm" variant="default" onclick={() => toggleUpstreamStatus(index)} disabled={saving || readOnly}>
                     {$_('routeEditor.enableUpstream')}
                   </Button>
                 {:else}
                   <Button size="sm" variant="destructive" onclick={() => toggleUpstreamStatus(index)} disabled={saving || readOnly}>
                     {$_('routeEditor.disableUpstream')}
                   </Button>
                 {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- 保存状态提示 -->
    {#if saving}
      <div class="border-l-2 border-l-nexus-500 bg-nexus-500/5 px-3 py-2 mt-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-command text-nexus-200">
        <LoadingIndicator label="" size="xs" centered={false} />
        <span>{$_('upstreamsModal.saving')}</span>
      </div>
    {/if}

    <div class="border-t border-carbon-600 px-4 py-3 flex justify-end gap-2 bg-carbon-900/60">
      <Button
        variant="ghost"
        onclick={closeModal}
        disabled={saving}
      >
        {#if saving}
          <LoadingIndicator label="" size="xs" centered={false} />
        {/if}
        {$_('upstreamsModal.close')}
      </Button>
    </div>
  </div>
  <form method="dialog" class="absolute inset-0 -z-10">
    <button on:click={closeModal}>close</button>
  </form>
</dialog>
