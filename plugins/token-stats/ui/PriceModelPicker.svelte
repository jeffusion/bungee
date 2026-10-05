<script lang="ts">
  import * as Popover from '$components/ui/popover';
  import * as Command from '$components/ui/command';
  import { Button } from '$components/ui/button';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import type { PriceModelOption } from '../server/model-mappings';

  let { options, value, disabled = false, label, placeholder, searchLabel, emptyLabel, onchange }: {
    options: PriceModelOption[];
    value: string;
    disabled?: boolean;
    label: string;
    placeholder: string;
    searchLabel: string;
    emptyLabel: string;
    onchange: (model: string) => void;
  } = $props();
  let open = $state(false);
  let width = $state(0);
  let search = $state('');
  const filteredOptions = $derived(options.filter(option =>
    `${option.model} ${option.name}`.toLowerCase().includes(search.trim().toLowerCase())));
</script>

<div class="min-w-0 w-full" bind:clientWidth={width}>
  <Popover.Root bind:open>
    <Popover.Trigger asChild let:builder>
      <Button builders={[builder]} variant="outline" {disabled} aria-label={label} aria-haspopup="listbox"
        onclick={() => { search = ''; }}
        class="h-[34px] w-full min-w-0 justify-between border-carbon-500 bg-carbon-900 px-2 font-mono text-[11px] font-normal normal-case tracking-normal focus-visible:border-nexus-500">
        <span class="truncate text-zinc-200" title={value}>{value || placeholder}</span>
        <ChevronDown class="h-4 w-4 shrink-0 opacity-50" />
      </Button>
    </Popover.Trigger>
    <Popover.Content style={`width: ${width}px`} class="max-w-[calc(100vw-2rem)] border-carbon-600 p-0" align="start">
      <!-- cmdk-sv's imperative sorting moves Svelte-owned nodes; keep filtering declarative. -->
      <Command.Root shouldFilter={false}>
        <Command.Input bind:value={search} placeholder={searchLabel} aria-label={searchLabel} />
        <Command.List>
          <Command.Empty>{emptyLabel}</Command.Empty>
          {#each filteredOptions as option (option.model)}
            <Command.Item value={option.model} onSelect={() => { onchange(option.model); open = false; }}
              class="min-w-0 break-all text-zinc-200">
              {option.model}
            </Command.Item>
          {/each}
        </Command.List>
      </Command.Root>
    </Popover.Content>
  </Popover.Root>
</div>
