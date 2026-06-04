<script lang="ts">
  import { Select as BitsSelect } from "bits-ui";
  import { cn } from "$utils";

  let {
    value = $bindable(),
    options = [],
    placeholder = "Choose...",
    ariaLabel = "",
    width = "",
    disabled = false,
    class: className = "",
    type = "single",
    id = "",
    dataTestid = "",
    onchange,
  }: {
    value?: string | string[];
    options: { value: string; label: string; id?: string }[];
    placeholder?: string;
    ariaLabel?: string;
    width?: string;
    disabled?: boolean;
    class?: string;
    type?: "single" | "multiple";
    id?: string;
    dataTestid?: string;
    onchange?: (value: string | string[]) => void;
  } = $props();

  $effect(() => {
    onchange?.(value ?? "");
  });

  type SelectOption = { value: string; label: string; id?: string };

  const arraysAreEqual = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

  let selectedItem = $derived.by(() => {
    if (type === "multiple") {
      const vals = Array.isArray(value) ? value : [];
      return options
        .filter((o) => vals.includes(o.value))
        .map((o) => ({ value: o.value, label: o.label }));
    } else {
      const found = options.find((o) => o.value === value);
      return found ? { value: found.value, label: found.label } : undefined;
    }
  });

  function handleSelectedChange(next: { value: string; label?: string } | { value: string; label?: string }[] | undefined) {
    if (type === "multiple") {
      const nextArr = Array.isArray(next) ? next : [];
      const nextVals = nextArr.map((o) => o.value);
      if (!Array.isArray(value) || !arraysAreEqual(value, nextVals)) {
        value = nextVals;
      }
    } else {
      const singleNext = next as { value: string; label?: string } | undefined;
      const nextVal = singleNext?.value ?? "";
      if (value !== nextVal) {
        value = nextVal;
      }
    }
  }

  let selectedLabel = $derived.by(() => {
    if (type === "multiple") {
      const vals = Array.isArray(value) ? value : [];
      return vals.length > 0
        ? options
            .filter((o) => vals.includes(o.value))
            .map((o) => o.label)
            .join(", ")
        : placeholder;
    } else {
      const found = options.find((o) => o.value === value);
      return found ? found.label : placeholder;
    }
  });
</script>

<BitsSelect.Root
  items={options}
  selected={selectedItem}
  onSelectedChange={handleSelectedChange}
  {disabled}
>
  <BitsSelect.Trigger
    {id}
    data-testid={dataTestid || undefined}
    aria-label={ariaLabel || undefined}
    class={cn(
      "border-carbon-500 bg-carbon-900 text-zinc-200 font-mono flex h-9 w-full items-center justify-between border px-3 py-1 text-sm transition-[color,box-shadow,border-color] outline-none placeholder:text-zinc-600 hover:border-carbon-400 focus-visible:border-nexus-500 focus-visible:ring-1 focus-visible:ring-nexus-500/60 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer",
      className
    )}
  >
    <span class={value ? "text-zinc-200" : "text-zinc-600"}>
      {selectedLabel}
    </span>
    <svg
      xmlns="http://www.w3.org/2000/svg"
      class="h-3 w-3 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M19 9l-7 7-7-7"
      />
    </svg>
  </BitsSelect.Trigger>
  <BitsSelect.Content
    class={cn(
      "z-[100] border border-carbon-500 bg-carbon-900 shadow-industrial-lg p-1 max-h-60 overflow-y-auto min-w-[var(--bits-select-anchor-width)]",
      width
    )}
    sideOffset={4}
  >
    {#each options as opt (opt.value)}
      <BitsSelect.Item
        id={opt.id}
        data-testid={opt.id}
        value={opt.value}
        label={opt.label}
        class="flex w-full items-center px-3 py-1.5 text-sm font-mono text-zinc-300 outline-none cursor-pointer transition-colors data-[highlighted]:bg-carbon-700 data-[selected]:bg-nexus-500/20 data-[selected]:text-nexus-300 data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed"
      >
        {opt.label}
      </BitsSelect.Item>
    {/each}
  </BitsSelect.Content>
</BitsSelect.Root>
