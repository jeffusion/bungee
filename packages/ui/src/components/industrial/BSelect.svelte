<script lang="ts">
	import X from "lucide-svelte/icons/x";
	import ChevronDown from "lucide-svelte/icons/chevron-down";
	import Loader2 from "lucide-svelte/icons/loader-2";
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
		placeholder = "Select...",
		ariaLabel,
		class: className = "",
		width = "",
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
		placeholder?: string;
		ariaLabel?: string;
		class?: string;
		width?: string;
		onchange?: (value: string | string[]) => void;
		onChange?: (value: string | string[]) => void;
		allowClear?: boolean;
		maxTagCount?: number;
		maxCount?: number;
		disabled?: boolean;
		loading?: boolean;
		status?: SelectStatus;
		size?: SelectSize;
	} = $props();

	let open = $state(false);
	let hovering = $state(false);

	let isMultiple = $derived(multiple || mode === "multiple" || mode === "tags");
	let selected = $derived(value ? { value, label: optionLabel(value) } : undefined);
	let selectedValues = $derived(values.map((item) => ({ value: item, label: optionLabel(item) })));
	let visibleTags = $derived(values.slice(0, maxTagCount));
	let omittedCount = $derived(Math.max(values.length - visibleTags.length, 0));

	let showClear = $derived(
		allowClear &&
		!disabled &&
		!loading &&
		hovering &&
		((isMultiple && values.length > 0) || (!isMultiple && value))
	);

	let sizeClass = $derived(size === "large" ? "min-h-[38px]" : size === "small" ? "min-h-[30px]" : "min-h-[34px]");
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

	function clearSelection(event: MouseEvent) {
		event.preventDefault();
		event.stopPropagation();
		if (isMultiple) {
			values = [];
			emit(values);
		} else {
			value = "";
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
</script>

<div
	role="presentation"
	class={cn("relative", width || "w-full", className)}
	onmouseenter={() => (hovering = true)}
	onmouseleave={() => (hovering = false)}
>
	{#if isMultiple}
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
<Select.Content class="min-w-[var(--bits-select-anchor-width)] !w-auto max-w-[320px]">
				{#each options as option (option.value)}
					<Select.Item value={option.value} label={option.label} disabled={option.disabled || (maxCount !== undefined && values.length >= maxCount && !values.includes(option.value))}>
						{option.label}
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	{:else}
		{#key value}
			<Select.Root bind:open {selected} onSelectedChange={handleSingleChange}>
				<Select.Trigger
					aria-label={ariaLabel}
					{disabled}
					hideIcon
					aria-invalid={status === "error" ? "true" : undefined}
					class={cn(
						"items-center justify-between gap-1 px-2 py-1",
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
<Select.Content class="min-w-[var(--bits-select-anchor-width)] !w-auto max-w-[320px]">
					{#each options as option (option.value)}
						<Select.Item value={option.value} label={option.label} disabled={option.disabled}>
							{option.label}
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		{/key}
	{/if}
</div>
