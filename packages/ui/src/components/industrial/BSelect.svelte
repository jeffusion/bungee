<script lang="ts">
	import X from "lucide-svelte/icons/x";
	import ChevronDown from "lucide-svelte/icons/chevron-down";
	import Loader2 from "lucide-svelte/icons/loader-2";
	import { onMount } from "svelte";
	import * as Select from "$components/ui/select";
	import { cn } from "$utils";

	type SelectOption = { label: string; value: string; disabled?: boolean };
	type SelectedOption = { value: string; label?: string };
	type SelectMode = "single" | "multiple" | "tags";
	type SelectStatus = "error" | "warning" | undefined;
	type SelectSize = "small" | "middle" | "large";

	let {
		options = [],
		value = $bindable(""),
		values = $bindable<string[]>([]),
		mode = "single",
		multiple = false,
		creatable = false,
		placeholder = "Select...",
		ariaLabel,
		class: className = "",
		width = "",
		autoWidth = false,
		onchange,
		onChange,
		allowClear = false,
		maxTagCount = 3,
		maxCount,
		disabled = false,
		loading = false,
		status,
		size = "middle",
	}: {
		options?: SelectOption[];
		value?: string;
		values?: string[];
		mode?: SelectMode;
		multiple?: boolean;
		creatable?: boolean;
		placeholder?: string;
		ariaLabel?: string;
		class?: string;
		width?: string;
		autoWidth?: boolean;
		onchange?: (value: string | string[]) => void;
		onChange?: (value: string | string[]) => void;
		allowClear?: boolean;
		maxTagCount?: number;
		disabled?: boolean;
		loading?: boolean;
		status?: SelectStatus;
		size?: SelectSize;
	} = $props();

	let open = $state(false);
	let hovering = $state(false);
	let searchText = $state("");
	let highlightedIndex = $state(-1);

	// Creatable dropdown refs
	let containerEl: HTMLDivElement | undefined = $state();
	let inputEl: HTMLInputElement | undefined = $state();

	// Width-stabilization ghost span (single mode only).
	// We render a hidden mirror of the trigger's internal layout using the
	// LONGEST label among `options`, measure its rendered width with
	// ResizeObserver, and fix the outer wrapper width to that value + padding
	// so switching selected option never resizes the trigger.
	let ghostEl: HTMLSpanElement | undefined = $state();
	let ghostWidth = $state(0);
	let longestLabel = $derived(
		options.reduce((max, o) => (o.label.length > max.length ? o.label : max), "")
	);

	function maybeMeasureGhost() {
		if (ghostEl) ghostWidth = ghostEl.offsetWidth;
	}

	$effect(() => {
		if (!ghostEl) return;
		const ro = new ResizeObserver(() => maybeMeasureGhost());
		ro.observe(ghostEl);
		maybeMeasureGhost();
		return () => ro.disconnect();
	});

	// Width assigned to the single-mode wrapper when autoWidth is enabled.
	// 16px = right padding inside trigger (px-2 = 8px) + chevron (16px) + 2px gap + safety.
	// Re-evaluate if trigger padding changes.
	let stableWidth = $derived(autoWidth && ghostWidth > 0 ? `width: ${ghostWidth + 16}px` : "");

	let isMultiple = $derived(multiple || mode === "multiple" || mode === "tags");
	let isTagsMode = $derived(mode === "tags");
	let isCreatableSingle = $derived(creatable && !isMultiple);
	let selected = $derived(value ? { value, label: optionLabel(value) } : undefined);
	let selectedValues = $derived(values.map((item) => ({ value: item, label: optionLabel(item) })));
	let visibleTags = $derived(values.slice(0, maxTagCount));
	let omittedCount = $derived(Math.max(values.length - visibleTags.length, 0));

	let dedupedOptions = $derived(
		(() => {
			const seen = new Set<string>();
			return options.filter((opt) => {
				if (seen.has(opt.value)) return false;
				seen.add(opt.value);
				return true;
			});
		})()
	);

	let filteredOptions = $derived(
		(isTagsMode || isCreatableSingle) && searchText
			? dedupedOptions.filter((opt) =>
					opt.label.toLowerCase().includes(searchText.toLowerCase()) ||
					opt.value.toLowerCase().includes(searchText.toLowerCase())
				)
			: dedupedOptions
	);

	let hasExactMatch = $derived(
		(isTagsMode || isCreatableSingle) && searchText
			? options.some((opt) => opt.value.toLowerCase() === searchText.toLowerCase())
			: true
	);

	let showClear = $derived(
		allowClear &&
		!disabled &&
		!loading &&
		hovering &&
		((isMultiple && values.length > 0) || (!isMultiple && value))
	);

	let sizeClass = $derived(size === "large" ? "min-h-[38px]" : size === "small" ? "min-h-[30px]" : "min-h-[34px]");
	let inputSizeClass = $derived(size === "large" ? "h-[38px]" : size === "small" ? "h-[30px]" : "h-[34px]");
	let statusClass = $derived(
		status === "error"
			? "border-red-500 focus-visible:ring-red-500"
			: status === "warning"
				? "border-amber-500 focus-visible:ring-amber-500"
				: ""
	);

	function optionLabel(optionValue: string) {
		return options.find((option) => option.value === optionValue)?.label ?? optionValue;
	}

	function emit(nextValue: string | string[]) {
		onchange?.(nextValue);
		onChange?.(nextValue);
	}

	function handleSingleChange(nextSelected?: SelectedOption) {
		value = nextSelected?.value ?? "";
		searchText = "";
		emit(value);
	}

	function handleMultipleChange(nextSelected: SelectedOption[]) {
		let nextValues = nextSelected.map((item) => item.value);
		if (maxCount !== undefined) {
			nextValues = nextValues.slice(0, maxCount);
		}
		values = nextValues;
		emit(values);
	}

	// --- Tags mode handlers ---
	function handleTagsInputKeydown(event: KeyboardEvent) {
		if (event.key === "Enter" && searchText.trim()) {
			event.preventDefault();
			const trimmed = searchText.trim();
			if (!values.includes(trimmed)) {
				values = [...values, trimmed];
				emit(values);
			}
			searchText = "";
		} else if (event.key === "Backspace" && !searchText && values.length > 0) {
			values = values.slice(0, -1);
			emit(values);
		}
	}

	// --- Creatable single mode handlers ---
	function handleCreatableInputFocus() {
		open = true;
		searchText = "";
		highlightedIndex = -1;
	}

	function handleCreatableInputChange(event: Event) {
		const target = event.target as HTMLInputElement;
		searchText = target.value;
		highlightedIndex = -1;
		open = true;
	}

	function handleCreatableInputKeydown(event: KeyboardEvent) {
		if (!open) return;
		const items = filteredOptions;
		const totalItems = items.length + (searchText.trim() && !hasExactMatch ? 1 : 0);

		if (event.key === "ArrowDown") {
			event.preventDefault();
			highlightedIndex = Math.min(highlightedIndex + 1, totalItems - 1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			highlightedIndex = Math.max(highlightedIndex - 1, 0);
		} else if (event.key === "Enter") {
			event.preventDefault();
			if (highlightedIndex >= 0 && highlightedIndex < items.length) {
				selectCreatableItem(items[highlightedIndex].value);
			} else if (highlightedIndex === items.length && searchText.trim() && !hasExactMatch) {
				// "Create xxx" option selected
				selectCreatableItem(searchText.trim());
			} else if (searchText.trim()) {
				// No item highlighted, just create from input
				selectCreatableItem(searchText.trim());
			}
		} else if (event.key === "Escape") {
			event.preventDefault();
			open = false;
			inputEl?.blur();
		}
	}

	function selectCreatableItem(itemValue: string) {
		value = itemValue;
		searchText = "";
		open = false;
		emit(value);
		inputEl?.blur();
	}

	function handleSearchInputChange(event: Event) {
		const target = event.target as HTMLInputElement;
		searchText = target.value;
	}

	function clearSelection(event: MouseEvent) {
		event.preventDefault();
		event.stopPropagation();
		if (isMultiple) {
			values = [];
			emit(values);
		} else {
			value = "";
			searchText = "";
			emit(value);
		}
	}

	function removeValue(removedValue: string) {
		if (disabled || loading) return;
		values = values.filter((item) => item !== removedValue);
		emit(values);
	}

	function handleRemovePointer(event: MouseEvent, removedValue: string) {
		event.preventDefault();
		event.stopPropagation();
		removeValue(removedValue);
	}

	function handleRemoveKey(event: KeyboardEvent, removedValue: string) {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		event.stopPropagation();
		removeValue(removedValue);
	}

	// Close creatable dropdown on outside click
	$effect(() => {
		if (!open) return;
		function handleClick(e: MouseEvent) {
			if (containerEl && !containerEl.contains(e.target as Node)) {
				open = false;
				searchText = "";
			}
		}
		document.addEventListener("click", handleClick, true);
		return () => document.removeEventListener("click", handleClick, true);
	});
</script>

<div
	role="presentation"
	class={cn("relative", width || "w-full", className)}
	onmouseenter={() => (hovering = true)}
	onmouseleave={() => (hovering = false)}
>
	{#if isCreatableSingle}
		<!-- Creatable single-select: Native input + custom dropdown (no Bits UI Select) -->
		<div bind:this={containerEl} class="relative">
			<div class={cn(
				"flex items-center justify-between gap-1 border-2 border-carbon-500 bg-carbon-900 px-2 py-0",
				inputSizeClass,
				statusClass,
				"focus-within:border-nexus-500 focus-within:ring-1 focus-within:ring-nexus-500/30",
			)}>
				{#if loading}
					<Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-500" />
				{/if}
				<input
					bind:this={inputEl}
					type="text"
					value={searchText || value}
					placeholder={placeholder}
					{disabled}
					class="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:ring-0 focus:outline-none"
					onfocus={handleCreatableInputFocus}
					oninput={handleCreatableInputChange}
					onkeydown={handleCreatableInputKeydown}
					aria-label={ariaLabel}
					aria-expanded={open}
					aria-haspopup="listbox"
					autocomplete="off"
				/>
				{#if showClear}
					<button
						type="button"
						class="shrink-0 text-zinc-500 transition-colors hover:text-red-300"
						aria-label="Clear selection"
						title="Clear"
						onclick={clearSelection}
					>
						<X class="h-3.5 w-3.5" />
					</button>
				{:else}
					<ChevronDown class="h-4 w-4 shrink-0 opacity-50" />
				{/if}
			</div>

			{#if open}
				<div
					class="absolute left-0 top-full z-50 mt-1 min-w-full overflow-hidden border border-carbon-600 bg-carbon-800 shadow-md outline-none"
					role="listbox"
				>
					<div class="p-1 max-h-[200px] overflow-y-auto">
						{#each filteredOptions as option, i}
							<button
								type="button"
								role="option"
								aria-selected={value === option.value}
								disabled={option.disabled}
								class={cn(
									"relative flex w-full cursor-default select-none items-center py-1.5 px-2 text-sm text-zinc-300 outline-none",
									option.disabled && "pointer-events-none opacity-50",
									value === option.value && "bg-nexus-500/15 text-nexus-400 font-semibold",
									highlightedIndex === i && "bg-carbon-700 text-zinc-100",
								)}
								onclick={() => selectCreatableItem(option.value)}
								onmouseenter={() => (highlightedIndex = i)}
							>
								{option.label}
							</button>
						{/each}
						{#if searchText.trim() && !hasExactMatch}
							{@const createIdx = filteredOptions.length}
							<button
								type="button"
								role="option"
								class={cn(
									"relative flex w-full cursor-default select-none items-center py-1.5 px-2 text-sm text-zinc-300 outline-none",
									highlightedIndex === createIdx && "bg-carbon-700 text-zinc-100",
								)}
								onclick={() => selectCreatableItem(searchText.trim())}
								onmouseenter={() => (highlightedIndex = createIdx)}
							>
								<span class="text-nexus-400">Create</span>&nbsp;"{searchText.trim()}"
							</button>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	{:else if isTagsMode}
		<!-- Tags/Combobox mode: Input + filtered dropdown (multiple values) -->
		<Select.Root multiple bind:open selected={selectedValues} onSelectedChange={handleMultipleChange}>
			<Select.Trigger
				aria-label={ariaLabel}
				{disabled}
				hideIcon
				aria-invalid={status === "error" ? "true" : undefined}
				class={cn(
					"h-auto min-h-[34px] items-center justify-between gap-1 px-2 py-1",
					sizeClass,
					statusClass
				)}
			>
				<div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
					{#each visibleTags as tag (tag)}
						<span class="inline-flex max-w-[120px] items-center gap-0.5 border border-carbon-500 bg-carbon-950 px-1.5 py-1 font-mono text-[10px] uppercase tracking-command text-zinc-200 leading-tight">
							<span class="truncate">{optionLabel(tag)}</span>
							<span role="button" tabindex="0" aria-label="Remove {optionLabel(tag)}" class="text-zinc-500 transition-colors hover:text-red-300" onclick={(event) => handleRemovePointer(event, tag)} onkeydown={(event) => handleRemoveKey(event, tag)}>
								<X class="h-2.5 w-2.5" />
							</span>
						</span>
					{/each}
					{#if omittedCount > 0}
						<span class="border border-nexus-500/40 bg-nexus-500/10 px-1.5 py-1 font-mono text-[10px] uppercase tracking-command text-nexus-300 leading-tight">+{omittedCount}</span>
					{/if}
					<input
						type="text"
						value={searchText}
						placeholder={values.length === 0 ? placeholder : ""}
						{disabled}
						class="min-w-[60px] flex-1 border-0 bg-transparent p-0 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:ring-0 focus:outline-none"
						oninput={handleSearchInputChange}
						onkeydown={handleTagsInputKeydown}
						onfocus={() => { open = true; }}
					/>
				</div>
				{#if showClear}
					<button
						type="button"
						class="shrink-0 text-zinc-500 transition-colors hover:text-red-300"
						aria-label="Clear selection"
						title="Clear"
						onmousedown={(event) => { event.preventDefault(); event.stopPropagation(); }}
						onclick={clearSelection}
					>
						<X class="h-3.5 w-3.5" />
					</button>
				{:else}
					<ChevronDown class="h-4 w-4 shrink-0 opacity-50" />
				{/if}
			</Select.Trigger>
			<Select.Content class="w-[var(--bits-select-anchor-width)]">
				{#each filteredOptions as option (option.value)}
					<Select.Item value={option.value} label={option.label} disabled={option.disabled}>
						{option.label}
					</Select.Item>
				{/each}
				{#if isTagsMode && searchText.trim() && !hasExactMatch}
					<Select.Item value={searchText.trim()} label={searchText.trim()}>
						<span class="text-nexus-400">Create</span> "{searchText.trim()}"
					</Select.Item>
				{/if}
			</Select.Content>
		</Select.Root>
	{:else if isMultiple}
		<Select.Root multiple bind:open selected={selectedValues} onSelectedChange={handleMultipleChange}>
			<Select.Trigger
				aria-label={ariaLabel}
				{disabled}
				hideIcon
				aria-invalid={status === "error" ? "true" : undefined}
				class={cn(
					"h-auto min-h-[34px] items-center justify-between gap-1 px-2 py-1",
					sizeClass,
					statusClass
				)}
			>
				<div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
					{#if values.length > 0}
						{#each visibleTags as tag (tag)}
							<span class="inline-flex max-w-[120px] items-center gap-0.5 border border-carbon-500 bg-carbon-950 px-1.5 py-1 font-mono text-[10px] uppercase tracking-command text-zinc-200 leading-tight">
								<span class="truncate">{optionLabel(tag)}</span>
								<span role="button" tabindex="0" aria-label="Remove {optionLabel(tag)}" class="text-zinc-500 transition-colors hover:text-red-300" onclick={(event) => handleRemovePointer(event, tag)} onkeydown={(event) => handleRemoveKey(event, tag)}>
									<X class="h-2.5 w-2.5" />
								</span>
							</span>
						{/each}
						{#if omittedCount > 0}
							<span class="border border-nexus-500/40 bg-nexus-500/10 px-1.5 py-1 font-mono text-[10px] uppercase tracking-command text-nexus-300 leading-tight">+{omittedCount}</span>
						{/if}
					{:else}
						<span class="text-zinc-600">{placeholder}</span>
					{/if}
				</div>
				{#if showClear}
					<button
						type="button"
						class="shrink-0 text-zinc-500 transition-colors hover:text-red-300"
						aria-label="Clear selection"
						title="Clear"
						onmousedown={(event) => { event.preventDefault(); event.stopPropagation(); }}
						onclick={clearSelection}
					>
						<X class="h-3.5 w-3.5" />
					</button>
				{:else}
					<ChevronDown class="h-4 w-4 shrink-0 opacity-50" />
				{/if}
			</Select.Trigger>
			<Select.Content class="w-[var(--bits-select-anchor-width)]">
				{#each options as option (option.value)}
					<Select.Item value={option.value} label={option.label} disabled={option.disabled || (maxCount !== undefined && values.length >= maxCount && !values.includes(option.value))}>
						{option.label}
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	{:else}
		<!-- Single mode: when autoWidth=true, outer width is derived from ghost span (stable across option changes). When autoWidth=false (default), trigger fills container via w-full. -->
		<div class="relative" style={stableWidth}>
			{#key value}
				<Select.Root bind:open {selected} onSelectedChange={handleSingleChange}>
					<Select.Trigger
						aria-label={ariaLabel}
						{disabled}
						hideIcon
						aria-invalid={status === "error" ? "true" : undefined}
						class={cn(
							"items-center justify-between gap-1 px-2 py-1 w-full",
							sizeClass,
							statusClass
						)}
					>
						{#if loading}
							<Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-500" />
						{/if}
						<Select.Value {placeholder} />
						{#if showClear}
							<button
								type="button"
								class="shrink-0 text-zinc-500 transition-colors hover:text-red-300"
								aria-label="Clear selection"
								title="Clear"
								onmousedown={(event) => { event.preventDefault(); event.stopPropagation(); }}
								onclick={clearSelection}
							>
								<X class="h-3.5 w-3.5" />
							</button>
						{:else}
							<ChevronDown class="h-4 w-4 shrink-0 opacity-50" />
						{/if}
					</Select.Trigger>
					<Select.Content class="w-[var(--bits-select-anchor-width)]">
						{#each options as option (option.value)}
							<Select.Item value={option.value} label={option.label} disabled={option.disabled}>
								{option.label}
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			{/key}

			{#if autoWidth}
				<!-- Ghost span: mirrors trigger layout using the LONGEST option label; measures its rendered width via ResizeObserver so we can fix the wrapper width to that value. DO NOT remove — without this, the trigger resizes every time the user picks a different option (regression has happened three times). Only rendered when autoWidth=true (route filter bars). -->
				<span
					bind:this={ghostEl}
					aria-hidden="true"
					class="pointer-events-none invisible absolute left-0 top-0 -z-10 inline-flex items-center gap-1 whitespace-nowrap border border-carbon-500 px-2 py-1 font-mono text-[11px] uppercase tracking-command text-zinc-200"
				>
					{#if loading}
						<span class="inline-block h-3.5 w-3.5"></span>
					{/if}
					<span>{longestLabel || placeholder}</span>
					<span class="inline-block h-4 w-4"></span>
				</span>
			{/if}
		</div>
	{/if}
</div>
