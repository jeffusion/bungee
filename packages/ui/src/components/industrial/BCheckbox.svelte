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

	const id = 'bcheckbox-' + Math.random().toString(36).slice(2, 10);

	function handleChange(newChecked: boolean | 'indeterminate') {
		checked = newChecked === true;
		onchange?.(checked);
	}
</script>

<div
	class={cn("flex items-center gap-2", disabled && "opacity-50", className)}
>
	<Checkbox.Root
		{id}
		bind:checked
		{disabled}
		{indeterminate}
		oncheckedchange={handleChange}
		class="cursor-pointer"
	/>
	<div class="space-y-0.5 min-w-0">
		{#if label}
			<label for={id} class="text-zinc-200 text-sm leading-tight cursor-pointer select-none">{label}</label>
		{/if}
		{#if description}
			<p class="font-mono text-[10px] uppercase tracking-command text-zinc-500 truncate">{description}</p>
		{/if}
	</div>
</div>
