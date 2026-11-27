<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { locale } from 'svelte-i18n';
  import ArrowDown from 'lucide-svelte/icons/arrow-down';
  import ArrowUp from 'lucide-svelte/icons/arrow-up';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import { IndustrialToggle, PanelCard, SegmentedControl } from '$components/industrial';
  import { Button } from '$components/ui/button';
  import { Textarea } from '$components/ui/textarea';
  import { DEFAULT_REDACTION_REPLACEMENT, MAX_REDACTION_FIELD_LENGTH, MAX_REDACTION_RULES, validateRedactionRule } from '../rules';

  let { value, label, onchange, onvalidate }: {
    value: unknown;
    label: string;
    onchange: (rules: unknown[]) => void;
    onvalidate: (invalid: boolean) => void;
  } = $props();

  const copy = $derived($locale?.startsWith('zh') ? {
    sequence: '从上到下执行，后续规则匹配替换后的文本。',
    add: '添加规则', reset: '清空规则', rule: '规则', kind: '匹配方式', literal: '字面文本', regex: '正则表达式',
    pattern: '匹配内容', replacement: '替换文本', custom: '自定义替换', empty: '留空则删除匹配内容。',
    fallback: `默认：${DEFAULT_REDACTION_REPLACEMENT}`,
    re2: 'RE2 语法，不加 /…/；(?i) 忽略大小写。',
    up: '上移', down: '下移', remove: '删除',
    limit: `最多 ${MAX_REDACTION_RULES} 条规则。`,
    invalidRule: '规则无效，请删除后重建。',
    invalidType: '请选择匹配方式。', invalidPattern: '无效的 RE2 正则表达式。',
    required: '请输入匹配内容。', tooLong: `不得超过 ${MAX_REDACTION_FIELD_LENGTH} 个 UTF-16 代码单元。`,
    invalidReplacement: '请输入有效的替换文本，或取消自定义。',
    invalidList: '已保存的规则格式无效，请清空后重建。',
  } : {
    sequence: 'Rules run top to bottom on the text left by earlier rules.',
    add: 'Add rule', reset: 'Clear rules', rule: 'Rule', kind: 'Match type', literal: 'Literal text', regex: 'Regex',
    pattern: 'Pattern', replacement: 'Replacement text', custom: 'Custom replacement', empty: 'Leave blank to delete matches.',
    fallback: `Default: ${DEFAULT_REDACTION_REPLACEMENT}`,
    re2: 'RE2 syntax without /…/; (?i) ignores case.',
    up: 'Move up', down: 'Move down', remove: 'Delete',
    limit: `Up to ${MAX_REDACTION_RULES} rules.`,
    invalidRule: 'Invalid rule. Delete and recreate it.',
    invalidType: 'Select a match type.', invalidPattern: 'Invalid RE2 expression.',
    required: 'Enter a pattern.', tooLong: `Use no more than ${MAX_REDACTION_FIELD_LENGTH} UTF-16 code units.`,
    invalidReplacement: 'Enter valid replacement text, or turn off custom replacement.',
    invalidList: 'Invalid saved rules. Clear and recreate them.',
  });

  const uid = $props.id();
  const rules = $derived(Array.isArray(value) ? value : []);
  const invalidList = $derived(value !== undefined && !Array.isArray(value));
  const rowErrors = $derived(rules.map(validateRedactionRule));
  const invalid = $derived(invalidList || !rules.length || rules.length > MAX_REDACTION_RULES || rowErrors.some(Boolean));
  let nextKey = 0;
  let keys = $state(untrack(() => rules.map(() => nextKey++)));
  const types = $derived([{ value: 'literal', label: copy.literal }, { value: 'regex', label: copy.regex }]);

  $effect(() => {
    const value = invalid;
    untrack(() => onvalidate(value));
  });

  function update(index: number, fields: Record<string, unknown>) {
    onchange(rules.map((rule, i) => i === index ? { ...rule, ...fields } : rule));
  }

  function setCustom(index: number, enabled: boolean) {
    const { replacement: _, ...rule } = rules[index];
    onchange(rules.map((item, i) => i !== index ? item : enabled ? { ...rule, replacement: '' } : rule));
  }

  function focusPattern(key: number | undefined) {
    void tick().then(() => (key === undefined ? document.getElementById(`${uid}-add`) :
      document.getElementById(`${uid}-${key}-pattern`) ?? document.getElementById(`${uid}-${key}-position`))?.focus());
  }

  function add() {
    const key = nextKey++;
    keys = [...keys, key];
    onchange([...rules, { type: 'literal', pattern: '' }]);
    focusPattern(key);
  }

  function remove(index: number) {
    keys = keys.filter((_, i) => i !== index);
    onchange(rules.filter((_, i) => i !== index));
    focusPattern(keys[index] ?? keys[index - 1]);
  }

  function move(index: number, direction: number) {
    const target = index + direction;
    const next = [...rules];
    const order = [...keys];
    [next[index], next[target]] = [next[target], next[index]];
    [order[index], order[target]] = [order[target], order[index]];
    keys = order;
    onchange(next);
    void tick().then(() => document.getElementById(`${uid}-${order[target]}-position`)?.focus());
  }
</script>

<section aria-labelledby={`${uid}-title`} class="space-y-3">
  <div class="space-y-1">
    <h3 id={`${uid}-title`} class="nx-field-label">{label}</h3>
    {#if rules.length > 1}<p class="text-sm text-zinc-400">{copy.sequence}</p>{/if}
  </div>
  {#each rules as rule, index (keys[index])}
    {@const id = `${uid}-${keys[index]}`}
    {@const issue = rowErrors[index]}
    {@const pattern = typeof rule?.pattern === 'string' ? rule.pattern : ''}
    {@const replacement = rule?.replacement}
    {@const custom = replacement !== undefined}
    <PanelCard corners={false} headless>
      <div class="space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-1.5">
          <h4 id={`${id}-position`} tabindex="-1" class="nx-field-label">{copy.rule} {index + 1}</h4>
          <div class="flex gap-1.5">
            {#each [{ key: 'up', icon: ArrowUp, direction: -1 }, { key: 'down', icon: ArrowDown, direction: 1 }] as action (action.key)}
              {@const text = `${action.direction < 0 ? copy.up : copy.down} · ${copy.rule} ${index + 1}`}
              <Button variant="ghost" size="icon" class="h-[44px] w-[44px] sm:h-[40px] sm:w-[40px]" aria-label={text} title={text}
                disabled={index + action.direction < 0 || index + action.direction >= rules.length}
                onclick={() => move(index, action.direction)}>
                <action.icon class="h-4 w-4" aria-hidden="true" />
              </Button>
            {/each}
            <Button variant="ghost" size="icon" class="h-[44px] w-[44px] sm:h-[40px] sm:w-[40px]" aria-label={`${copy.remove} · ${copy.rule} ${index + 1}`}
              title={copy.remove} onclick={() => remove(index)}>
              <Trash2 class="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
        {#if issue === 'invalidRule'}
          <p class="text-sm text-red-300">{copy.invalidRule}</p>
        {:else}
          <div class="space-y-1.5">
            <div class="nx-field-label">{copy.kind}</div>
            <SegmentedControl options={types} value={rule?.type} ariaLabel={copy.kind} class="min-h-[44px] sm:min-h-0"
              onchange={type => update(index, { type })} />
            {#if issue === 'invalidType'}<p class="text-sm text-red-300">{copy.invalidType}</p>{/if}
          </div>
          <div class="space-y-1.5">
            <label id={`${id}-pattern-label`} class="nx-field-label block" for={`${id}-pattern`}>{copy.pattern}</label>
            <Textarea id={`${id}-pattern`} rows={2} class="min-h-0" value={pattern}
              spellcheck={false} aria-required="true" aria-invalid={issue === 'invalidPattern'}
              aria-labelledby={`${id}-position ${id}-pattern-label`}
              aria-describedby={issue === 'invalidPattern' || rule?.type === 'regex' ? `${id}-pattern-help` : undefined}
              oninput={event => update(index, { pattern: (event.target as HTMLTextAreaElement).value })} />
            {#if issue === 'invalidPattern'}
              <p id={`${id}-pattern-help`} class="text-sm text-red-300">
                {!pattern.length ? copy.required : pattern.length > MAX_REDACTION_FIELD_LENGTH ? copy.tooLong : copy.invalidPattern}
              </p>
            {:else if rule?.type === 'regex'}
              <p id={`${id}-pattern-help`} class="text-sm text-zinc-400">{copy.re2}</p>
            {/if}
          </div>
          <div class="space-y-1.5">
            <div class="flex items-center gap-1.5">
              <IndustrialToggle id={`${id}-custom`} label={copy.custom} checked={custom}
                onchange={enabled => setCustom(index, enabled)} />
              <label for={`${id}-custom`} class="nx-field-label cursor-pointer">{copy.custom}</label>
            </div>
            {#if custom}
              <label id={`${id}-replacement-label`} class="nx-field-label block" for={`${id}-replacement`}>{copy.replacement}</label>
              <Textarea id={`${id}-replacement`} class="min-h-0" rows={2} spellcheck={false}
                value={typeof replacement === 'string' ? replacement : ''}
                aria-labelledby={`${id}-position ${id}-replacement-label`}
                aria-invalid={issue === 'invalidReplacement'} aria-describedby={`${id}-replacement-help`}
                oninput={event => update(index, { replacement: (event.target as HTMLTextAreaElement).value })} />
              <p id={`${id}-replacement-help`} class="text-sm {issue === 'invalidReplacement' ? 'text-red-300' : 'text-zinc-400'}">
                {issue === 'invalidReplacement'
                  ? typeof replacement === 'string' && replacement.length > MAX_REDACTION_FIELD_LENGTH ? copy.tooLong : copy.invalidReplacement
                  : copy.empty}
              </p>
            {:else}
              <p class="text-sm text-zinc-400">{copy.fallback}</p>
            {/if}
          </div>
        {/if}
      </div>
    </PanelCard>
  {/each}
  {#if invalidList}
    <Button variant="outline" size="sm" class="min-h-[44px] sm:min-h-0" onclick={() => { onchange([]); focusPattern(undefined); }}>{copy.reset}</Button>
  {:else}
    <Button id={`${uid}-add`} variant="outline" size="sm" class="min-h-[44px] sm:min-h-0" disabled={rules.length >= MAX_REDACTION_RULES} onclick={add}>{copy.add}</Button>
  {/if}
  {#if invalidList}<p role="status" class="text-sm text-red-300">{copy.invalidList}</p>
  {:else if rules.length >= MAX_REDACTION_RULES}
    <p class="text-sm {rules.length > MAX_REDACTION_RULES ? 'text-red-300' : 'text-zinc-400'}">{copy.limit}</p>
  {/if}
</section>
