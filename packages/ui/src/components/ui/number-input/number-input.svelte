<script lang="ts">
  import { untrack } from 'svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { Input, type FormInputEvent } from '$components/ui/input';
  import { buttonVariants } from '$components/ui/button';
  import { cn } from '$utils';
  import ChevronUp from 'lucide-svelte/icons/chevron-up';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';

  let { value = $bindable<number | undefined>(), min, max, emptyValue, required = false, disabled = false,
    readonly = false, increaseLabel, decreaseLabel, invalidMessage, invalid: externalInvalid = false,
    step: stepMode, class: className, ...props }: Omit<HTMLInputAttributes,
      'value' | 'min' | 'max' | 'type' | 'step' | 'inputmode' | 'pattern'> & {
    value?: number; min: number; max: number; emptyValue?: number;
    increaseLabel: string; decreaseLabel: string; invalidMessage: string;
    /** Caller-owned error (server/domain), merged with the local range check. */
    invalid?: boolean;
    /** HTML step="any": decimals allowed; arrows still step by one whole unit. */
    step?: 'any';
  } = $props();
  let root: HTMLDivElement;
  let accepted = untrack(() => value === undefined ? '' : formatNumber(value));
  let draft = $state(accepted);
  let published = untrack(() => value);
  let composing = false;
  let selection: [number, number] = [0, 0];
  const allowDecimal = $derived(stepMode === 'any');
  const digits = /^[0-9]*$/;
  const decimal = /^\d*\.?\d*$/;
  const numeric = $derived(draft === '' || (allowDecimal && draft === '.') ? undefined : Number(draft));
  const numericValid = $derived(numeric !== undefined
    && (allowDecimal ? Number.isFinite(numeric) : Number.isSafeInteger(numeric)));
  // Caller-owned errors merge into the component's own invalid state and ARIA.
  const callerInvalid = $derived(externalInvalid || props['aria-invalid'] === true || props['aria-invalid'] === 'true');
  const invalid = $derived((required && draft === '') || (allowDecimal && draft === '.')
    || (numeric !== undefined && !numericValid)
    || (numeric !== undefined && (numeric < min || numeric > max)) || callerInvalid);
  const buttonClass = cn(buttonVariants({ variant: 'ghost', size: 'icon' }),
    'h-[17px] w-7 border-0 border-l border-carbon-500 focus-visible:ring-1 !min-h-0');
  const input = () => root?.querySelector('input');
  function formatNumber(number: number) {
    const text = String(number);
    // Keep generated values free of exponent notation, which the digit filter rejects.
    return /e/i.test(text) ? number.toFixed(20).replace(/0+$/, '').replace(/\.$/, '') : text;
  }
  function validity(node = input()) { node?.setCustomValidity(invalid && draft !== '' ? invalidMessage : ''); }

  $effect(() => {
    const external = value;
    void min; void max; void required; void callerInvalid; void allowDecimal;
    untrack(() => {
      if (external !== published) {
        published = external;
        accepted = draft = external === undefined ? '' : formatNumber(external);
      }
      validity();
    });
  });
  function accept(node: HTMLInputElement, text: string) {
    accepted = draft = text;
    node.value = text;
    const next = text === '' ? emptyValue : Number(text);
    published = (allowDecimal ? Number.isFinite(next) : Number.isSafeInteger(next)) ? next : emptyValue;
    value = published;
    validity(node);
  }
  function restore(node: HTMLInputElement) {
    draft = accepted;
    node.value = accepted;
    node.setSelectionRange(Math.min(selection[0], accepted.length), Math.min(selection[1], accepted.length));
  }
  function beforeInput(event: FormInputEvent<InputEvent>) {
    if (composing || event.isComposing) return;
    selection = [event.currentTarget.selectionStart ?? 0, event.currentTarget.selectionEnd ?? 0];
    if (event.data !== null && !(allowDecimal ? decimal : digits).test(event.data)) event.preventDefault();
  }
  function applyText(node: HTMLInputElement) {
    const text = node.value;
    if (disabled || readonly || !(allowDecimal ? decimal : digits).test(text)) { restore(node); return; }
    // Keep a lone decimal point visible without publishing it as a value.
    if (allowDecimal && text === '.') { draft = text; validity(node); return; }
    accept(node, text);
  }
  function change(event: FormInputEvent<InputEvent>) {
    if (composing || event.isComposing) return;
    applyText(event.currentTarget);
  }
  function paste(event: FormInputEvent<ClipboardEvent>) {
    if (disabled || readonly || !(allowDecimal ? decimal : digits).test(event.clipboardData?.getData('text') ?? '')) event.preventDefault();
  }
  function commit() {
    const node = input();
    if (!node || disabled || readonly || composing) return;
    accept(node, draft === '' || (allowDecimal && draft === '.') ? ''
      : formatNumber(Math.min(max, Math.max(min, Number(draft)))));
  }
  function step(delta: number) {
    const node = input();
    if (!node || disabled || readonly || composing) return;
    accept(node, formatNumber(numeric === undefined ? min : Math.min(max, Math.max(min, numeric + delta))));
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
    applyText(event.currentTarget);
  }
  function clickStep(event: MouseEvent, delta: number) {
    step(delta);
    if (event.detail > 0) input()?.focus();
  }
</script>

<div class="relative w-full" bind:this={root}>
  <Input {...props} class={cn('pr-9', className)} value={draft} type="text"
    inputmode={allowDecimal ? 'decimal' : 'numeric'} pattern={allowDecimal ? undefined : '[0-9]*'}
    role="spinbutton" {required} {disabled} {readonly} aria-valuemin={min} aria-valuemax={max}
    aria-valuenow={numericValid ? numeric : undefined} aria-invalid={invalid}
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
