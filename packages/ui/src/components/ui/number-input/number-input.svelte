<script lang="ts">
  import { untrack } from 'svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { Input, type FormInputEvent } from '$components/ui/input';
  import { buttonVariants } from '$components/ui/button';
  import { cn } from '$utils';
  import ChevronUp from 'lucide-svelte/icons/chevron-up';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';

  let { value = $bindable<number | undefined>(), min, max, required = false, disabled = false,
    readonly = false, increaseLabel, decreaseLabel, invalidMessage, class: className, ...props }: Omit<HTMLInputAttributes,
      'value' | 'min' | 'max' | 'type' | 'step' | 'inputmode' | 'pattern'> & {
    value?: number; min: number; max: number;
    increaseLabel: string; decreaseLabel: string; invalidMessage: string;
  } = $props();
  let root: HTMLDivElement;
  let accepted = untrack(() => value === undefined ? '' : String(value));
  let draft = $state(accepted);
  let published = untrack(() => value);
  let composing = false;
  let selection: [number, number] = [0, 0];
  const numeric = $derived(draft === '' ? undefined : Number(draft));
  const invalid = $derived((required && draft === '') || (numeric !== undefined
    && (!Number.isSafeInteger(numeric) || numeric < min || numeric > max)));
  const buttonClass = cn(buttonVariants({ variant: 'ghost', size: 'icon' }),
    'h-[17px] w-7 border-0 border-l border-carbon-500 focus-visible:ring-1');
  const input = () => root?.querySelector('input');
  function validity(node = input()) { node?.setCustomValidity(invalid && draft !== '' ? invalidMessage : ''); }

  $effect(() => {
    const external = value;
    void min; void max; void required;
    untrack(() => {
      if (external !== published) {
        published = external;
        accepted = draft = external === undefined ? '' : String(external);
      }
      validity();
    });
  });
  function accept(node: HTMLInputElement, text: string) {
    accepted = draft = text;
    node.value = text;
    const next = text === '' ? undefined : Number(text);
    published = Number.isSafeInteger(next) ? next : undefined;
    value = published;
    validity(node);
  }
  function restore(node: HTMLInputElement) {
    node.value = accepted;
    node.setSelectionRange(Math.min(selection[0], accepted.length), Math.min(selection[1], accepted.length));
  }
  function beforeInput(event: FormInputEvent<InputEvent>) {
    if (composing || event.isComposing) return;
    selection = [event.currentTarget.selectionStart ?? 0, event.currentTarget.selectionEnd ?? 0];
    if (event.data !== null && !/^[0-9]*$/.test(event.data)) event.preventDefault();
  }
  function change(event: FormInputEvent<InputEvent>) {
    if (composing || event.isComposing) return;
    if (disabled || readonly || !/^[0-9]*$/.test(event.currentTarget.value)) restore(event.currentTarget);
    else accept(event.currentTarget, event.currentTarget.value);
  }
  function paste(event: FormInputEvent<ClipboardEvent>) {
    if (disabled || readonly || !/^[0-9]*$/.test(event.clipboardData?.getData('text') ?? '')) event.preventDefault();
  }
  function commit() {
    const node = input();
    if (!node || disabled || readonly || composing) return;
    accept(node, draft === '' ? '' : String(Math.min(max, Math.max(min, Number(draft)))));
  }
  function step(delta: number) {
    const node = input();
    if (!node || disabled || readonly || composing) return;
    accept(node, String(numeric === undefined ? min : Math.min(max, Math.max(min, numeric + delta))));
  }
  function keydown(event: FormInputEvent<KeyboardEvent>) {
    if (event.isComposing || composing || disabled || readonly || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault(); step(event.key === 'ArrowUp' ? 1 : -1);
    } else if (event.key === 'Enter') commit();
  }
  function compositionStart(event: FormInputEvent<CompositionEvent>) {
    composing = true;
    selection = [event.currentTarget.selectionStart ?? 0, event.currentTarget.selectionEnd ?? 0];
  }
  function compositionEnd(event: FormInputEvent<CompositionEvent>) {
    composing = false;
    if (disabled || readonly || !/^[0-9]*$/.test(event.currentTarget.value)) restore(event.currentTarget);
    else accept(event.currentTarget, event.currentTarget.value);
  }
  function clickStep(event: MouseEvent, delta: number) {
    step(delta);
    if (event.detail > 0) input()?.focus();
  }
</script>

<div class="relative w-full" bind:this={root}>
  <Input {...props} class={cn('pr-9', className)} value={draft} type="text" inputmode="numeric" pattern="[0-9]*"
    role="spinbutton" {required} {disabled} {readonly} aria-valuemin={min} aria-valuemax={max}
    aria-valuenow={numeric !== undefined && Number.isSafeInteger(numeric) ? numeric : undefined} aria-invalid={invalid}
    on:beforeinput={beforeInput} on:input={change} on:paste={paste} on:keydown={keydown} on:blur={commit}
    on:compositionstart={compositionStart} on:compositionend={compositionEnd} />
  <div class="absolute inset-y-0 right-0 flex flex-col">
    <button type="button" class={buttonClass} aria-label={increaseLabel}
      disabled={disabled || readonly || (numeric !== undefined && numeric >= max)}
      onmousedown={(event) => event.preventDefault()} onclick={(event) => clickStep(event, 1)}><ChevronUp size={12} /></button>
    <button type="button" class={buttonClass} aria-label={decreaseLabel}
      disabled={disabled || readonly || (numeric !== undefined && numeric <= min)}
      onmousedown={(event) => event.preventDefault()} onclick={(event) => clickStep(event, -1)}><ChevronDown size={12} /></button>
  </div>
</div>
