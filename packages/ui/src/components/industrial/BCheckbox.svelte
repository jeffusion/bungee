<script lang="ts">
	import * as Checkbox from "$components/ui/checkbox";
	import { cn } from "$utils";

	let {
		label = "",
		description = "",
		checked = $bindable(false),
		disabled = false,
		indeterminate = false,
		onchange,
		class: className = "",
	}: {
		label?: string;
		description?: string;
		checked?: boolean;
		disabled?: boolean;
		indeterminate?: boolean;
		onchange?: (checked: boolean) => void;
		class?: string;
	} = $props();

	function handleChange() {
		onchange?.(checked);
	}
</script>

<div class={cn("flex items-center justify-between gap-3 border border-carbon-600 bg-carbon-900/40 px-3 py-2", disabled && "opacity-50 cursor-not-allowed", className)}>
	<div class="space-y-0.5 min-w-0">
		{#if label}
			<label for={label} class="text-zinc-200 text-sm leading-tight">{label}</label>
		{/if}
		{#if description}
			<p class="font-mono text-[10px] uppercase tracking-command text-zinc-500 truncate">{description}</p>
		{/if}
	</div>
	<Checkbox.Root
		id={label}
		bind:checked
		{disabled}
		{indeterminate}
		onchange={handleChange}
		aria-label={label || undefined}
	/>
</div>
