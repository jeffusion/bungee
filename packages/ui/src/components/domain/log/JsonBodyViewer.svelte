<script lang="ts">
  import { onDestroy } from 'svelte';
  import { JSONEditor, expandAll as expandAllNodes, getSelectionPaths, Mode } from 'svelte-jsoneditor';
  import type { Content, JSONEditorSelection, JSONSelection } from 'svelte-jsoneditor';

  export let value: unknown = null;
  export let emptyText = '';
  export let copyText = 'Copy';
  export let copiedText = 'Copied';
  export let copyFailedText = 'Copy failed';
  export let copySelectionText = 'Copy selection';
  export let copyAllContentText = 'Copy all content';
  export let expandAllText = 'Expand all';
  export let collapseAllText = 'Collapse all';
  export let defaultExpandDepth = 2;

  const UNINITIALIZED = Symbol('json-body-viewer-uninitialized');

  let editor: InstanceType<typeof JSONEditor> | null = null;
  let content: Content = { json: null };
  let copyFeedback = false;
  let copyFailed = false;
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
  let lastExpandedValue: unknown | typeof UNINITIALIZED = UNINITIALIZED;
  let contextMenuVisible = false;
  let contextMenuLeft = 8;
  let contextMenuTop = 8;
  let hasSelectionInViewer = false;
  let viewerRoot: HTMLDivElement | null = null;
  let viewerContentArea: HTMLDivElement | null = null;
  let contextMenuElement: HTMLDivElement | null = null;
  let editorSelection: JSONEditorSelection | undefined = undefined;
  let cachedRightClickSelectionText = '';
  let contextSelectionText = '';

  function normalizeValue(input: unknown): unknown {
    return input === undefined ? null : input;
  }

  function toClipboardText(input: unknown): string {
    if (typeof input === 'string') {
      return input;
    }

    if (input === undefined || input === null) {
      return '';
    }

    return JSON.stringify(input, null, 2);
  }

  function resetCopyFeedbackTimer(): void {
    if (copyResetTimer) {
      clearTimeout(copyResetTimer);
    }

    copyResetTimer = setTimeout(() => {
      copyFeedback = false;
      copyFailed = false;
    }, 1500);
  }

  async function writeTextToClipboard(text: string): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }

      copyFeedback = true;
      copyFailed = false;
    } catch (error) {
      copyFeedback = false;
      copyFailed = true;
      console.error('Failed to copy body content:', error);
    }

    resetCopyFeedbackTimer();
  }

  function getSelectedTextInViewer(): string {
    if (!viewerRoot) {
      return '';
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return '';
    }

    const range = selection.getRangeAt(0);
    const commonAncestor = range.commonAncestorContainer;
    if (!viewerRoot.contains(commonAncestor)) {
      return '';
    }

    return selection.toString();
  }

  function getValueByPath(source: unknown, path: Array<string | number>): unknown {
    let current: unknown = source;

    for (const segment of path) {
      if (current === null || current === undefined) {
        return undefined;
      }

      if (Array.isArray(current) && typeof segment === 'number') {
        current = current[segment];
        continue;
      }

      if (typeof current === 'object') {
        current = (current as Record<string, unknown>)[String(segment)];
        continue;
      }

      return undefined;
    }

    return current;
  }

  function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function serializeValue(valueToSerialize: unknown): string {
    if (typeof valueToSerialize === 'string') {
      return valueToSerialize;
    }

    if (valueToSerialize === undefined) {
      return '';
    }

    return JSON.stringify(valueToSerialize, null, 2);
  }

  function serializeObjectEntry(key: string | number, valueToSerialize: unknown): string {
    const serializedKey = JSON.stringify(String(key));
    const serializedValue =
      typeof valueToSerialize === 'string'
        ? JSON.stringify(valueToSerialize)
        : JSON.stringify(valueToSerialize, null, 2);

    return `${serializedKey}: ${serializedValue}`;
  }

  function getSelectedTextFromEditorSelection(): string {
    const selection = editorSelection;
    if (!selection || selection.type === 'text') {
      return '';
    }

    const rootJson = normalizeValue(value);

    if (selection.type === 'key') {
      return selection.path.length > 0 ? String(selection.path[selection.path.length - 1]) : '';
    }

    if (selection.type === 'value') {
      const selectedValue = getValueByPath(rootJson, selection.path);
      if (selectedValue === undefined) {
        return '';
      }

      if (selection.path.length > 0) {
        const parentValue = getValueByPath(rootJson, selection.path.slice(0, -1));
        const key = selection.path[selection.path.length - 1];

        if (key !== undefined && isPlainObject(parentValue)) {
          return serializeObjectEntry(key, selectedValue);
        }
      }

      return serializeValue(selectedValue);
    }

    if (selection.type === 'multi') {
      const multiSelection = selection as JSONSelection;

      if (selection.focusPath.length === 0) {
        return JSON.stringify(rootJson, null, 2);
      }

      const parentPath = selection.focusPath.slice(0, -1);
      const parentValue = getValueByPath(rootJson, parentPath);
      const selectedPaths = getSelectionPaths(rootJson, multiSelection);

      if (selectedPaths.length === 0) {
        return '';
      }

      if (Array.isArray(parentValue)) {
        return selectedPaths
          .map((path, index) => {
            const item = getValueByPath(rootJson, path);
            const serialized = serializeValue(item);
            return selectedPaths.length > 1 && index < selectedPaths.length - 1
              ? `${serialized},`
              : serialized;
          })
          .join('\n');
      }

      if (isPlainObject(parentValue)) {
        return selectedPaths
          .map((path, index) => {
            const key = path[path.length - 1];
            if (key === undefined) {
              return '';
            }

            const item = getValueByPath(rootJson, path);
            const serialized = serializeObjectEntry(key, item);
            return selectedPaths.length > 1 && index < selectedPaths.length - 1
              ? `${serialized},`
              : serialized;
          })
          .filter((line) => line.length > 0)
          .join('\n');
      }
    }

    return '';
  }

  function getCopySelectionText(): string {
    const domSelection = getSelectedTextInViewer();
    if (domSelection.length > 0) {
      return domSelection;
    }

    return getSelectedTextFromEditorSelection();
  }

  function captureSelectionForContextMenu(): void {
    const liveSelection = getCopySelectionText();
    contextSelectionText = liveSelection || cachedRightClickSelectionText;
    hasSelectionInViewer = contextSelectionText.length > 0;
  }

  function updateHasSelectionState(): void {
    hasSelectionInViewer = getCopySelectionText().length > 0;
  }

  function closeContextMenu(): void {
    contextMenuVisible = false;
    hasSelectionInViewer = false;
    contextSelectionText = '';
    cachedRightClickSelectionText = '';
  }

  function openContextMenu(event: MouseEvent): void {
    event.preventDefault();

    captureSelectionForContextMenu();
    showContextMenuAt(event.clientX, event.clientY);
  }

  function handleWindowContextMenu(event: MouseEvent): void {
    if (!viewerContentArea) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Node) || !viewerContentArea.contains(target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    openContextMenu(event);
  }

  function showContextMenuAt(clientX: number, clientY: number): void {
    const menuWidth = 160;
    const menuHeight = 84;

    if (viewerRoot) {
      const rect = viewerRoot.getBoundingClientRect();
      const relativeLeft = clientX - rect.left;
      const relativeTop = clientY - rect.top;
      const maxLeft = Math.max(rect.width - menuWidth - 8, 8);
      const maxTop = Math.max(rect.height - menuHeight - 8, 8);

      contextMenuLeft = Math.min(Math.max(relativeLeft, 8), maxLeft);
      contextMenuTop = Math.min(Math.max(relativeTop, 8), maxTop);
      contextMenuVisible = true;
      return;
    }

    const maxLeft = Math.max(window.innerWidth - menuWidth - 8, 8);
    const maxTop = Math.max(window.innerHeight - menuHeight - 8, 8);
    contextMenuLeft = Math.min(Math.max(clientX, 8), maxLeft);
    contextMenuTop = Math.min(Math.max(clientY, 8), maxTop);
    contextMenuVisible = true;
  }

  function openContextMenuFromKeyboard(event: KeyboardEvent): void {
    const isContextMenuKey = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
    if (!isContextMenuKey) {
      return;
    }

    const target = event.currentTarget as HTMLElement | null;
    if (!target) {
      return;
    }

    event.preventDefault();
    const rect = target.getBoundingClientRect();
    captureSelectionForContextMenu();
    showContextMenuAt(rect.left + 16, rect.top + 16);
  }

  function handleWindowMouseDown(event: MouseEvent): void {
    if (event.button === 2 && viewerContentArea) {
      const target = event.target;
      if (target instanceof Node && viewerContentArea.contains(target)) {
        cachedRightClickSelectionText = getSelectedTextInViewer();
      }
    }

    if (!contextMenuVisible) {
      return;
    }

    const target = event.target;
    if (target instanceof Node && contextMenuElement?.contains(target)) {
      return;
    }

    closeContextMenu();
  }

  function handleEditorSelect(selection: JSONEditorSelection | undefined): void {
    editorSelection = selection;

    if (!contextMenuVisible) {
      updateHasSelectionState();
    }
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && contextMenuVisible) {
      closeContextMenu();
    }
  }

  async function copyAll(): Promise<void> {
    await writeTextToClipboard(toClipboardText(value));
    closeContextMenu();
  }

  async function copySelectionFromMenu(): Promise<void> {
    const selection = contextSelectionText || getCopySelectionText();
    if (!selection) {
      copyFeedback = false;
      copyFailed = true;
      resetCopyFeedbackTimer();
      closeContextMenu();
      return;
    }

    await writeTextToClipboard(selection);
    closeContextMenu();
  }

  async function expandAll(): Promise<void> {
    if (!editor) {
      return;
    }

    await editor.expand([], expandAllNodes);
  }

  async function collapseAll(): Promise<void> {
    if (!editor) {
      return;
    }

    await editor.collapse([], true);
  }

  function normalizeExpandDepth(input: number): number {
    if (!Number.isFinite(input)) {
      return 0;
    }

    return Math.max(0, Math.floor(input));
  }

  async function applyDefaultExpansion(): Promise<void> {
    if (!editor) {
      return;
    }

    const depth = normalizeExpandDepth(defaultExpandDepth);
    await editor.collapse([], true);

    if (depth === 0) {
      return;
    }

    await editor.expand([], (relativePath) => relativePath.length < depth);
  }

  async function syncEditorWithCurrentValue(): Promise<void> {
    if (!editor) {
      return;
    }

    await editor.update(content);

    if (value === lastExpandedValue) {
      return;
    }

    lastExpandedValue = value;
    await applyDefaultExpansion();
  }

  $: content = { json: normalizeValue(value) };

  $: if (editor) {
    void syncEditorWithCurrentValue();
  }

  onDestroy(() => {
    if (copyResetTimer) {
      clearTimeout(copyResetTimer);
    }
  });
</script>

<svelte:window
  on:keydown={handleWindowKeydown}
  on:contextmenu|capture={handleWindowContextMenu}
  on:mousedown|capture={handleWindowMouseDown}
/>

{#if value === undefined}
  <div class="text-sm opacity-60">{emptyText}</div>
{:else}
  <div class="space-y-2 viewer-shell relative" bind:this={viewerRoot}>
    <div class="flex flex-wrap items-center gap-2">
      <button class="nx-btn-ghost nx-btn-sm" on:click={expandAll}>{expandAllText}</button>
      <button class="nx-btn-ghost nx-btn-sm" on:click={collapseAll}>{collapseAllText}</button>
      <button class="nx-btn-ghost nx-btn-sm" on:click={copyAll}>
        {#if copyFeedback}
          <span class="text-success">{copiedText}</span>
        {:else if copyFailed}
          <span class="text-red-300">{copyFailedText}</span>
        {:else}
          {copyText}
        {/if}
      </button>
    </div>
    <div
      class="bg-carbon-900 border border-carbon-600 p-2 max-h-96 overflow-auto"
      bind:this={viewerContentArea}
      role="button"
      tabindex="0"
      on:keydown={openContextMenuFromKeyboard}
    >
      <JSONEditor
        bind:this={editor}
        {content}
        mode={Mode.tree}
        readOnly={true}
        mainMenuBar={false}
        navigationBar={false}
        statusBar={false}
        onSelect={handleEditorSelect}
      />
    </div>

    {#if contextMenuVisible}
      <div
        bind:this={contextMenuElement}
        class="absolute z-50 w-[148px] border border-carbon-500 bg-carbon-900 p-1 shadow-industrial-lg"
        style={`left: ${contextMenuLeft}px; top: ${contextMenuTop}px;`}
        role="menu"
        tabindex="0"
        on:contextmenu|preventDefault
      >
        <button
          class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-carbon-950/60 disabled:opacity-40 disabled:cursor-not-allowed"
          on:click={copySelectionFromMenu}
          disabled={!hasSelectionInViewer}
        >
          {copySelectionText}
        </button>
        <button class="mt-0.5 w-full rounded px-2 py-1.5 text-left text-sm hover:bg-carbon-950/60" on:click={copyAll}>
          {copyAllContentText}
        </button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .viewer-shell {
    /* base theme */
    --jse-theme: dark;
    --jse-theme-color: #f97316; /* nexus orange accent */
    --jse-theme-color-highlight: #fb923c;
    --jse-background-color: transparent;
    --jse-text-color: #e4e4e7; /* zinc-200 */
    --jse-text-color-inverse: #52525b; /* zinc-600 */

    --jse-main-border: 1px solid #3f3f46; /* carbon-700 */
    --jse-menu-color: #e4e4e7;
    --jse-modal-background: #18181b; /* carbon-950 */
    --jse-modal-overlay-background: rgba(0, 0, 0, 0.6);
    --jse-modal-code-background: #18181b;

    /* tooltip */
    --jse-tooltip-color: #e4e4e7;
    --jse-tooltip-background: #27272a; /* carbon-800 */
    --jse-tooltip-border: 1px solid #52525b; /* zinc-600 */
    --jse-tooltip-action-button-color: inherit;
    --jse-tooltip-action-button-background: #52525b;

    /* panels (hidden, but kept for completeness) */
    --jse-panel-background: #1f1f23;
    --jse-panel-background-border: 1px solid #3f3f46;
    --jse-panel-color: #e4e4e7;
    --jse-panel-color-readonly: #71717a; /* zinc-400 */
    --jse-panel-border: 1px solid #3f3f46;
    --jse-panel-button-color-highlight: #f4f4f5;
    --jse-panel-button-background-highlight: #3f3f46;

    --jse-navigation-bar-background: #27272a;
    --jse-navigation-bar-background-highlight: #3f3f46;
    --jse-navigation-bar-dropdown-color: #e4e4e7;

    /* context menu (we render our own; kept for safety) */
    --jse-context-menu-background: #18181b;
    --jse-context-menu-background-highlight: #27272a;
    --jse-context-menu-separator-color: #3f3f46;
    --jse-context-menu-color: #e4e4e7;
    --jse-context-menu-pointer-background: #3f3f46;
    --jse-context-menu-pointer-background-highlight: #52525b;
    --jse-context-menu-pointer-color: #e4e4e7;

    /* json contents */
    --jse-key-color: #fb923c; /* nexus-300 - keys pop in orange */
    --jse-value-color: #e4e4e7; /* zinc-200 - base value */
    --jse-value-color-number: #a1a1aa; /* zinc-400 */
    --jse-value-color-boolean: #38bdf8; /* info blue */
    --jse-value-color-null: #71717a; /* zinc-400 muted */
    --jse-value-color-string: #86efac; /* green-300 - string lits */
    --jse-value-color-url: #38bdf8;
    --jse-delimiter-color: #71717a;
    --jse-edit-outline: 2px solid #f97316;

    /* selection */
    --jse-selection-background-color: #3f3f46;
    --jse-selection-background-inactive-color: #27272a;
    --jse-hover-background-color: rgba(249, 115, 22, 0.08); /* subtle orange wash */
    --jse-active-line-background-color: rgba(244, 244, 245, 0.04);
    --jse-search-match-background-color: #3f3f46;

    /* collapsed array items */
    --jse-collapsed-items-background-color: #1f1f23;
    --jse-collapsed-items-selected-background-color: #3f3f46;
    --jse-collapsed-items-link-color: #a1a1aa;
    --jse-collapsed-items-link-color-highlight: #fb923c;

    /* search match highlight */
    --jse-search-match-color: #724c27;
    --jse-search-match-outline: 1px solid #966535;
    --jse-search-match-active-color: #9f6c39;
    --jse-search-match-active-outline: 1px solid #bb7f43;

    /* inline tags */
    --jse-tag-background: #27272a;
    --jse-tag-color: #a1a1aa;

    /* table mode (not used here, but kept) */
    --jse-table-header-background: #1f1f23;
    --jse-table-header-background-highlight: #27272a;
    --jse-table-row-odd-background: rgba(244, 244, 245, 0.03);

    /* controls */
    --jse-input-background: #1f1f23;
    --jse-input-border: 1px solid #3f3f46;
    --jse-button-background: #52525b;
    --jse-button-background-highlight: #71717a;
    --jse-button-color: #f4f4f5;
    --jse-button-secondary-background: #3f3f46;
    --jse-button-secondary-background-highlight: #52525b;
    --jse-button-secondary-background-disabled: #27272a;
    --jse-button-secondary-color: #e4e4e7;
    --jse-a-color: #38bdf8;
    --jse-a-color-highlight: #7dd3fc;

    /* svelte-select (third-party internal) */
    --jse-svelte-select-background: #1f1f23;
    --jse-svelte-select-border: 1px solid #3f3f46;
    --list-background: #1f1f23;
    --item-hover-bg: #3f3f46;
    --multi-item-bg: #3f3f46;
    --input-color: #e4e4e7;
    --multi-clear-bg: #52525b;
    --multi-item-clear-icon-color: #e4e4e7;
    --multi-item-outline: 1px solid #52525b;
    --list-shadow: 0 2px 8px 0 rgba(0, 0, 0, 0.4);

    /* color picker (not used, kept) */
    --jse-color-picker-background: #27272a;
    --jse-color-picker-border-box-shadow: #52525b 0 0 0 1px;

    /* font family */
    --jse-font-family-mono: ui-monospace, 'JetBrains Mono', 'Fira Code', SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  }
</style>
