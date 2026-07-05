<script lang="ts">
	import * as Switch from "$components/ui/switch";
	import { cn } from "$utils";

	let {
		label = "",
		description = "",
		checked = $bindable(false),
		disabled = false,
		showChildren = true,
		size = "default",
		onchange,
		class: className = "",
	}: {
		label?: string;
		description?: string;
		checked?: boolean;
		disabled?: boolean;
		showChildren?: boolean;
		size?: "large" | "default" | "small";
		onchange?: (checked: boolean) => void;
		class?: string;
	} = $props();

	// Stable unique ID per instance — avoids collision when multiple BSwitch
	// labels share the same text (especially CJK i18n where all IDs would
	// collapse to "bswitch-" if derived from label text alone).
	let switchId = `bswitch-${Math.random().toString(36).slice(2, 10)}`;

	function handleChange() {
		onchange?.(checked);
	}
</script>

{#if label}
	<!-- svelte-ignore a11y_label_associated_control -->
	<label
		for={switchId}
		class={cn(
			"inline-flex items-center justify-between gap-4",
			disabled && "cursor-not-allowed opacity-50",
			className
		)}
	>
		<div class="min-w-0 space-y-0.5">
			<span class="text-sm leading-tight text-zinc-200">{label}</span>
			{#if description}
				<p class="truncate font-mono text-[10px] uppercase tracking-command text-zinc-500">{description}</p>
			{/if}
		</div>
		<Switch.Root
			id={switchId}
			bind:checked
			{disabled}
			{showChildren}
			{size}
			onchange={handleChange}
			aria-label={label}
		/>
	</label>
{:else}
	<div class={cn("inline-flex items-center", disabled && "opacity-50", className)}>
		<Switch.Root
			bind:checked
			{disabled}
			{showChildren}
			{size}
			onchange={handleChange}
			aria-label={description || "switch"}
		/>
	</div>
{/if}
