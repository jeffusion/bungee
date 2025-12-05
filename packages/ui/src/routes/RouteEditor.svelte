<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { pop } from 'svelte-spa-router';
  import { sortBy } from 'lodash-es';
  import { RoutesAPI } from '../lib/api/routes';
  import type { Route } from '../lib/api/routes';
  import { validateRoute, validateWeights, type ValidationError } from '../lib/validation';
  import Toast from '../lib/components/Toast.svelte';
  import RouteTemplates from '../lib/components/RouteTemplates.svelte';
  import BasicInfoSection from '../lib/components/sections/BasicInfoSection.svelte';
  import UpstreamsSection from '../lib/components/sections/UpstreamsSection.svelte';
  import ModificationSection from '../lib/components/sections/ModificationSection.svelte';
  import AuthSection from '../lib/components/sections/AuthSection.svelte';
  import FailoverSection from '../lib/components/sections/FailoverSection.svelte';
  import PreviewSection from '../lib/components/sections/PreviewSection.svelte';
  import { toast } from '../lib/stores/toast';
  import { _ } from '../lib/i18n';
  import { v4 as uuidv4 } from 'uuid';
  import { isMac, getModifierKey, isModifierPressed } from '../lib/utils/platform';

  export let params: { path?: string } = {};

  let isEditMode = false;
  let originalPath = '';
  let loading = true;
  let saving = false;
  let showTemplates = false;
  let activeSection: 'basic' | 'upstreams' | 'modification' | 'auth' | 'failover' | 'preview' = 'basic';
  let showValidationDetails = false;

  let route: Route = {
    path: '',
    upstreams: [{
      _uid: uuidv4(),
      target: '',
      weight: 100,
      priority: 1
    }],
    headers: { add: {}, remove: [], default: {} },
    body: { add: {}, remove: [], replace: {}, default: {} },
    query: { add: {}, remove: [], replace: {}, default: {} },
  };

  // Validation
  let errors: ValidationError[] = [];
  let weightErrors: ValidationError[] = [];
  let allErrors: ValidationError[] = [];
  let isValid = false;
  let validationDebounce: number | null = null;

  // Auto-save draft
  let lastAutoSave: number | null = null;
  let autoSaveInterval: number | null = null;

  // Toast notification
  let showToast = false;
  let toastMessage = '';
  let toastType: 'success' | 'error' | 'warning' | 'info' = 'success';

  // Confirmation dialog
  let showConfirmDialog = false;
  let confirmDialogTitle = '';
  let confirmDialogMessage = '';
  let confirmDialogCallback: (() => void) | null = null;

  function showSuccessToast(message: string) {
    toastMessage = message;
    toastType = 'success';
    showToast = true;
  }

  function showErrorToast(message: string) {
    toastMessage = message;
    toastType = 'error';
    showToast = true;
  }

  function showConfirm(title: string, message: string, callback: () => void) {
    confirmDialogTitle = title;
    confirmDialogMessage = message;
    confirmDialogCallback = callback;
    showConfirmDialog = true;
  }

  function handleConfirmYes() {
    showConfirmDialog = false;
    if (confirmDialogCallback) {
      confirmDialogCallback();
      confirmDialogCallback = null;
    }
  }

  function handleConfirmNo() {
    showConfirmDialog = false;
    confirmDialogCallback = null;
  }

  // Keyboard shortcuts
  function handleKeydown(event: KeyboardEvent) {
    // Cmd/Ctrl + S: Save
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      if (isValid && !saving) {
        handleSave();
      }
    }

    // Esc: Cancel
    if (event.key === 'Escape') {
      handleCancel();
    }

    // Cmd/Ctrl + Number keys 1-6: Switch sections (Mac: ⌘+1-6, Windows/Linux: Ctrl+1-6)
    if (event.key >= '1' && event.key <= '6' && isModifierPressed(event) && !event.altKey) {
      const sections: typeof activeSection[] = ['basic', 'upstreams', 'modification', 'auth', 'failover', 'preview'];
      const targetSection = sections[parseInt(event.key) - 1];
      if (targetSection) {
        activeSection = targetSection;
        event.preventDefault();
      }
    }
  }

  // Auto-save to localStorage
  function autoSaveDraft() {
    if (!isEditMode) {
      try {
        localStorage.setItem('bungee-route-draft', JSON.stringify(route));
        lastAutoSave = Date.now();
      } catch (e) {
        console.error('Failed to auto-save draft:', e);
      }
    }
  }

  // Format relative time
  function formatRelativeTime(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return $_('autosave.justNow');
    if (seconds < 3600) return $_('autosave.minutesAgo', { values: { minutes: Math.floor(seconds / 60) } });
    return $_('autosave.hoursAgo', { values: { hours: Math.floor(seconds / 3600) } });
  }

  // Async validation
  async function performValidation() {
    try {
      const routeErrors = await validateRoute(route);
      const routeWeightErrors = validateWeights(route.upstreams);

      errors = routeErrors;
      weightErrors = routeWeightErrors;
      allErrors = [...routeErrors, ...routeWeightErrors];
      isValid = allErrors.length === 0 && route.upstreams.length > 0;
    } catch (error) {
      console.error('Validation failed:', error);
      isValid = false;
    }
  }

  // Reactive validation (debounced)
  $: {
    route && (() => {
      if (validationDebounce) {
        clearTimeout(validationDebounce);
      }
      validationDebounce = setTimeout(() => {
        performValidation();
      }, 300) as any;
    })();
  }

  async function handleSave() {
    if (!isValid) {
      toast.show($_('routeEditor.saveFailed', { values: { error: $_('common.error') } }), 'error');
      return;
    }

    try {
      saving = true;

      const sortedRoute = {
        ...route,
        upstreams: sortBy(route.upstreams, [(up: any) => up.priority ?? 1]).map(({ _uid, ...upstream }: any) => upstream)
      };

      if (isEditMode) {
        await RoutesAPI.update(originalPath, sortedRoute);
        toast.show($_('routeEditor.routeUpdated'), 'success');
      } else {
        await RoutesAPI.create(sortedRoute);
        toast.show($_('routeEditor.routeSaved'), 'success');
        // Clear draft after successful save
        localStorage.removeItem('bungee-route-draft');
      }

      pop();
    } catch (e: any) {
      toast.show($_('routeEditor.saveFailed', { values: { error: e.message } }), 'error');
    } finally {
      saving = false;
    }
  }

  function handleCancel() {
    showConfirm(
      $_('confirmDialog.cancelTitle'),
      $_('confirmDialog.cancelMessage'),
      () => pop()
    );
  }

  function handleTemplateSelect(event: CustomEvent<Partial<Route>>) {
    const template = event.detail;
    route = {
      ...route,
      ...template,
      headers: template.headers || route.headers,
      body: template.body || route.body,
      query: template.query || route.query,
      upstreams: template.upstreams?.map(u => ({
        ...u,
        _uid: uuidv4(),
        headers: u.headers || { add: {}, remove: [], default: {} },
        body: u.body || { add: {}, remove: [], replace: {}, default: {} },
        query: u.query || { add: {}, remove: [], replace: {}, default: {} }
      })) || route.upstreams
    };

    toast.show($_('routeEditor.templateApplied'), 'success');
  }

  onMount(async () => {
    // Add keyboard event listener
    window.addEventListener('keydown', handleKeydown);

    // Start auto-save interval (every 30 seconds)
    autoSaveInterval = setInterval(() => {
      autoSaveDraft();
    }, 30000) as any;

    if (params.path) {
      isEditMode = true;
      originalPath = decodeURIComponent(params.path);

      try {
        const existingRoute = await RoutesAPI.get(originalPath);
        if (existingRoute) {
          route = existingRoute;
          route.headers = route.headers || { add: {}, remove: [], default: {} };
          route.body = route.body || { add: {}, remove: [], replace: {}, default: {} };
          route.query = route.query || { add: {}, remove: [], replace: {}, default: {} };
          route.upstreams = route.upstreams.map(u => ({
            ...u,
            _uid: uuidv4(),
            headers: u.headers || { add: {}, remove: [], default: {} },
            body: u.body || { add: {}, remove: [], replace: {}, default: {} },
            query: u.query || { add: {}, remove: [], replace: {}, default: {} }
          }));
        } else {
          toast.show($_('routes.noRoutes'), 'error');
          pop();
        }
      } catch (e: any) {
        toast.show($_('routeEditor.saveFailed', { values: { error: e.message } }), 'error');
        pop();
      }
    } else {
      // Try to restore draft for new routes
      try {
        const draft = localStorage.getItem('bungee-route-draft');
        if (draft) {
          const parsedDraft = JSON.parse(draft);
          showConfirm(
            $_('confirmDialog.restoreDraftTitle'),
            $_('confirmDialog.restoreDraftMessage'),
            () => {
              route = parsedDraft;
            }
          );
        }
      } catch (e) {
        console.error('Failed to restore draft:', e);
      }
    }
    loading = false;
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown);
    if (autoSaveInterval) {
      clearInterval(autoSaveInterval);
    }
  });
</script>

<div class="min-h-screen bg-base-200">
  <!-- Page Title Area -->
  <div class="bg-base-100 border-b border-base-300">
    <div class="max-w-7xl mx-auto px-6 py-4">
      <!-- Breadcrumb Navigation with Path -->
      <div class="breadcrumbs text-sm">
        <ul>
          <li>
            <button type="button" class="link link-hover" on:click={() => window.location.hash = '/'}>
              {$_('breadcrumb.home')}
            </button>
          </li>
          <li>
            <button type="button" class="link link-hover" on:click={() => window.location.hash = '/routes'}>
              {$_('breadcrumb.routes')}
            </button>
          </li>
          <li>
            <span class="flex items-center gap-2">
              <span>{isEditMode ? $_('breadcrumb.editRoute') : $_('breadcrumb.newRoute')}</span>
              {#if isEditMode}
                <code class="px-2 py-1 bg-base-200 rounded text-sm font-mono text-gray-600">
                  {originalPath}
                </code>
              {/if}
            </span>
          </li>
        </ul>
      </div>
    </div>
  </div>

  {#if loading}
    <div class="flex justify-center items-center h-64">
      <span class="loading loading-spinner loading-lg"></span>
    </div>
  {:else}
    <!-- Main Content: Left Nav + Right Content -->
    <div class="max-w-7xl mx-auto flex gap-0 p-6 pb-32">
      <!-- Left Navigation -->
      <div class="w-56 flex-shrink-0 relative z-10">
        <div class="sticky top-24">
          <ul class="menu bg-base-100 rounded-box shadow-lg gap-1">
            <li>
              <button
                class:active={activeSection === 'basic'}
                on:click={() => activeSection = 'basic'}
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {$_('routeEditor.basicInfo')}
              </button>
            </li>
            <li>
              <button
                class:active={activeSection === 'upstreams'}
                on:click={() => activeSection = 'upstreams'}
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                {$_('routeEditor.upstreams')}
                <span
                  class="badge badge-sm tooltip tooltip-right"
                  data-tip={$_('routeEditor.upstreamCountTooltip', { values: { count: route.upstreams.length } })}
                >
                  {route.upstreams.length}
                </span>
              </button>
            </li>
            <li>
              <button
                class:active={activeSection === 'modification'}
                on:click={() => activeSection = 'modification'}
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                {$_('routeEditor.requestModification')}
              </button>
            </li>
            <li>
              <button
                class:active={activeSection === 'auth'}
                on:click={() => activeSection = 'auth'}
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                {$_('auth.routeAuth')}
                {#if route.auth?.enabled}
                  <span class="badge badge-success badge-xs">✓</span>
                {/if}
              </button>
            </li>
            <li>
              <button
                class:active={activeSection === 'failover'}
                on:click={() => activeSection = 'failover'}
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {$_('routeEditor.failoverTitle')}
                {#if route.failover?.enabled}
                  <span class="badge badge-success badge-xs">✓</span>
                {/if}
              </button>
            </li>
            <li>
              <button
                class:active={activeSection === 'preview'}
                on:click={() => activeSection = 'preview'}
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                {$_('routeEditor.preview')}
              </button>
            </li>
          </ul>

          <!-- Keyboard Shortcuts Hint -->
          <div class="mt-4 p-3 bg-base-100 rounded-box shadow-lg text-xs">
            <div class="font-semibold mb-2">{$_('shortcuts.title')}</div>
            <div class="space-y-1 text-gray-500">
              <div>
                <kbd class="kbd kbd-xs">{getModifierKey()}</kbd> + <kbd class="kbd kbd-xs">S</kbd>
                <span class="ml-1">{$_('shortcuts.save')}</span>
              </div>
              <div>
                <kbd class="kbd kbd-xs">{getModifierKey()}</kbd> + <kbd class="kbd kbd-xs">1-6</kbd>
                <span class="ml-1">{$_('shortcuts.switchSection')}</span>
              </div>
              <div>
                <kbd class="kbd kbd-xs">Esc</kbd>
                <span class="ml-1">{$_('shortcuts.cancel')}</span>
              </div>
            </div>
          </div>

          <!-- Template Button (New Route Only) -->
          {#if !isEditMode}
            <div class="mt-4">
              <button
                type="button"
                class="btn btn-sm btn-outline w-full gap-2"
                on:click={() => showTemplates = true}
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                {$_('routeEditor.useTemplate')}
              </button>
            </div>
          {/if}
        </div>
      </div>

      <!-- Right Content Area -->
      <div class="flex-1 ml-6 relative">
        <div class="card bg-base-100 shadow-md">
          <div class="card-body">
            {#if activeSection === 'basic'}
              <BasicInfoSection bind:route {errors} />
            {:else if activeSection === 'upstreams'}
              <UpstreamsSection bind:route {errors} {weightErrors} />
            {:else if activeSection === 'modification'}
              <ModificationSection bind:route />
            {:else if activeSection === 'auth'}
              <AuthSection bind:route />
            {:else if activeSection === 'failover'}
              <FailoverSection bind:route />
            {:else if activeSection === 'preview'}
              <PreviewSection {route} />
            {/if}
          </div>
        </div>
      </div>
    </div>
  {/if}

  <!-- Fixed Bottom Action Bar -->
  <div class="fixed bottom-0 left-0 right-0 bg-base-100 border-t border-base-300 shadow-2xl z-40">
    <div class="max-w-7xl mx-auto px-6 py-4">
      <div class="flex justify-between items-center">
        <!-- Left: Auto-save indicator -->
        <div class="flex items-center gap-4">
          {#if lastAutoSave && !isEditMode}
            <span class="text-xs text-gray-500">
              {$_('autosave.lastSaved')}: {formatRelativeTime(lastAutoSave)}
            </span>
          {/if}
        </div>

        <!-- Right: Validation Status & Action Buttons -->
        <div class="flex items-center gap-4">
          <!-- Validation Status -->
          {#if allErrors.length > 0}
            <div class="flex items-center gap-2 text-error">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span class="text-sm font-medium">
                {allErrors.length} {$_('validation.errors')}
              </span>
              <button
                class="btn btn-xs btn-ghost"
                on:click={() => showValidationDetails = !showValidationDetails}
              >
                {showValidationDetails ? $_('common.hide') : $_('common.show')}
              </button>
            </div>
          {:else if isValid}
            <div class="flex items-center gap-2 text-success">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span class="text-sm font-medium">
                {$_('validation.allGood')}
              </span>
            </div>
          {/if}

          <!-- Action Buttons -->
          <div class="flex gap-3">
            <button
              class="btn btn-outline"
              on:click={handleCancel}
              disabled={saving}
            >
              {$_('common.cancel')}
            </button>
            <button
              class="btn btn-primary"
              disabled={!isValid || saving}
              on:click={handleSave}
            >
              {#if saving}
                <span class="loading loading-spinner loading-sm"></span>
              {:else}
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                </svg>
              {/if}
              {$_('common.save')}
            </button>
          </div>
        </div>
      </div>

      <!-- Validation Error Details (Expandable) -->
      {#if showValidationDetails && allErrors.length > 0}
        <div class="mt-3 p-3 bg-error/10 rounded-lg border border-error/20">
          <ul class="text-sm space-y-1">
            {#each allErrors as error}
              <li class="flex items-start gap-2">
                <span class="text-error">•</span>
                <span>{error.field}: {error.message}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  </div>

  <!-- Route Templates Modal -->
  <RouteTemplates bind:showTemplates on:select={handleTemplateSelect} />

  <!-- Confirmation Dialog -->
  <dialog class="modal" class:modal-open={showConfirmDialog}>
    <div class="modal-box">
      <h3 class="font-bold text-lg">{confirmDialogTitle}</h3>
      <p class="py-4">{confirmDialogMessage}</p>
      <div class="modal-action">
        <button class="btn btn-ghost" on:click={handleConfirmNo}>
          {$_('confirmDialog.no')}
        </button>
        <button class="btn btn-primary" on:click={handleConfirmYes}>
          {$_('confirmDialog.yes')}
        </button>
      </div>
    </div>
    <button type="button" class="modal-backdrop" on:click={handleConfirmNo} aria-label="Close dialog"></button>
  </dialog>
</div>
