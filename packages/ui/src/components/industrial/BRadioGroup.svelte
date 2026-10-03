<script lang="ts">
	import * as RadioGroup from "$components/ui/radio-group";
	import * as Label from "$components/ui/label";
	import { cn } from "$utils";

	type RadioOption = { label: string; value: string; description?: string; disabled?: boolean };

	let {
		label = "",
		description = "",
		options = [],
		value = $bindable(""),
		disabled = false,
		onchange,
		class: className = "",
		ariaLabel,
	}: {
		label?: string;
		description?: string;
		options?: RadioOption[];
		value?: string;
		disabled?: boolean;
		onchange?: (value: string) => void;
		class?: string;
		ariaLabel?: string;
	} = $props();

	const groupId = $props.id();

	function handleChange(next: string) {
		value = next;
		onchange?.(next);
	}
</script>

<div class={cn("space-y-1.5", className)}>
	{#if label}
		<div class="flex items-center justify-between gap-3">
			<Label.Root>{label}</Label.Root>
			{#if value}
				<span class="font-mono text-[10px] uppercase tracking-command text-nexus-300">{value}</span>
			{/if}
		</div>
	{/if}
	{#if description}
		<p class="font-mono text-[10px] uppercase tracking-command text-zinc-500">{description}</p>
	{/if}
	<RadioGroup.Root bind:value {disabled} onValueChange={handleChange} class="gap-2" aria-label={ariaLabel || label || undefined}>
		{#each options as opt, index (opt.value)}
			<label for={`${groupId}-${index}`} class={cn(
				"flex items-center justify-between gap-3 border border-carbon-600 px-3 py-2",
				opt.disabled || disabled ? "bg-carbon-950/60 opacity-60 cursor-not-allowed" : "bg-carbon-900/40 cursor-pointer"
			)}>
				<span class="block space-y-0.5">
					<span id={`${groupId}-${index}-label`} class="text-zinc-200 text-sm leading-tight">{opt.label}</span>
					{#if opt.description}
						<span id={`${groupId}-${index}-description`} class="block font-mono text-[10px] uppercase tracking-command text-zinc-500">{opt.description}</span>
					{/if}
				</span>
				<RadioGroup.Item id={`${groupId}-${index}`} aria-labelledby={`${groupId}-${index}-label`} aria-describedby={opt.description ? `${groupId}-${index}-description` : undefined} value={opt.value} disabled={opt.disabled || disabled} />
			</label>
		{/each}
	</RadioGroup.Root>
</div>
