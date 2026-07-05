<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { _ } from '$i18n';
  import { createParser, createFormatter, isVirtualField } from '$utils/field-transform';
  import ModelMappingEditor from '$components/domain/model-mapping/ModelMappingEditor.svelte';
  import { Input } from '$components/ui/input';
  import { Textarea } from '$components/ui/textarea';
  import { BCheckbox, BSelect } from '$components/industrial';

  export let schema: any[] = [];
  export let value: Record<string, any> = {};
  export let errors: Record<string, string> = {};
  export let pluginName = '';

  const dispatch = createEventDispatcher();

  $: formattedValues = schema.reduce((acc, field) => {
    if (field.fieldTransform) {
      const formatter = createFormatter(field.fieldTransform);
      if (formatter) {
        acc[field.name] = formatter(value[field.name], value);
      } else {
        acc[field.name] = value[field.name];
      }
    } else {
      acc[field.name] = value[field.name];
    }
    return acc;
  }, {} as Record<string, any>);

  function getFieldValue(field: any) {
    return formattedValues[field.name] ?? '';
  }

  function handleChange(fieldName: string, newValue: any) {
    const field = schema.find(f => f.name === fieldName);

    if (field?.fieldTransform) {
      const parser = createParser(field.fieldTransform);
      if (parser) {
        const parsed = parser(newValue, value);

        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          const nextValue = { ...value, ...parsed };
          delete nextValue[fieldName];
          value = nextValue;
        } else {
          value = { ...value, [fieldName]: parsed };
        }
      } else {
        value = { ...value, [fieldName]: newValue };
      }
    } else {
      value = { ...value, [fieldName]: newValue };
    }

    dispatch('value', value);
    dispatch('change', value);
  }

  function buildShowIfContext(currentValue: Record<string, any>): Record<string, any> {
    const context: Record<string, any> = { ...currentValue };

    for (const field of schema) {
      if (!field?.fieldTransform) continue;

      const parser = createParser(field.fieldTransform);
      const rawVirtualValue = currentValue[field.name];
      if (parser && typeof rawVirtualValue === 'string' && rawVirtualValue.length > 0) {
        const parsed = parser(rawVirtualValue, currentValue);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          Object.assign(context, parsed);
        }
      }

      const formatter = createFormatter(field.fieldTransform);
      if (!formatter) continue;

      const virtualValue = formatter(context[field.name], context);
      if (virtualValue !== undefined && virtualValue !== null && virtualValue !== '') {
        context[field.name] = virtualValue;
      }
    }

    return context;
  }

  function matchesShowCondition(condition: any, context: Record<string, any>): boolean {
    if (!condition || typeof condition !== 'object') return true;

    if (Array.isArray(condition.all)) {
      return condition.all.every((item: any) => matchesShowCondition(item, context));
    }

    if (Array.isArray(condition.any)) {
      return condition.any.some((item: any) => matchesShowCondition(item, context));
    }

    if (typeof condition.field === 'string') {
      const fieldValue = context[condition.field];
      return fieldValue === condition.value;
    }

    return true;
  }

  function shouldShow(field: any, context: Record<string, any>): boolean {
    if (!field.showIf) return true;
    return matchesShowCondition(field.showIf, context);
  }

  $: showIfContext = buildShowIfContext(value);

  $: visibleFieldNames = new Set(
    schema
      .filter((field) => shouldShow(field, showIfContext))
      .map((field) => field?.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)
  );

  function validateField(field: any, val: any): string | null {
    if (isVirtualField(field)) {
      if (field.required && field.fieldTransform?.fields) {
        const missingFields = field.fieldTransform.fields.filter(
          (realField: string) => !value[realField]
        );
        if (missingFields.length > 0) {
          return `${$_(field.label)} is required`;
        }
      }
      return null;
    }

    const isEmptyArray = Array.isArray(val) && val.length === 0;
    if (field.required && (val === undefined || val === null || val === '' || isEmptyArray)) {
      return `${$_(field.label)} is required`;
    }

    if (field.validation) {
      const { pattern, min, max, message } = field.validation;

      if (pattern && typeof val === 'string') {
        const regex = new RegExp(pattern);
        if (!regex.test(val)) {
          return message || `Invalid format for ${$_(field.label)}`;
        }
      }

      if (min !== undefined) {
        const numVal = typeof val === 'number' ? val : (typeof val === 'string' ? val.length : 0);
        if (numVal < min) {
          return message || `${$_(field.label)} must be at least ${min}`;
        }
      }

      if (max !== undefined) {
        const numVal = typeof val === 'number' ? val : (typeof val === 'string' ? val.length : 0);
        if (numVal > max) {
          return message || `${$_(field.label)} must be at most ${max}`;
        }
      }
    }

    return null;
  }

  function handleBlur(field: any) {
    const error = validateField(field, value[field.name]);
    if (error) {
      errors = { ...errors, [field.name]: error };
    } else {
      const { [field.name]: _, ...rest } = errors;
      errors = rest;
    }
    dispatch('errors', errors);
    dispatch('validate', errors);
  }

  function resolveModelCatalogPlugin(field: any): string {
    if (typeof field?.catalogPlugin === 'string' && field.catalogPlugin.length > 0) {
      return field.catalogPlugin;
    }
    return pluginName || 'model-mapping';
  }

  function resolveModelCatalogProvider(field: any, key: 'sourceCatalogProviderField' | 'targetCatalogProviderField'): string {
    const providerField = field?.[key];
    if (typeof providerField !== 'string' || providerField.length === 0) {
      return '';
    }

    const providerValue = showIfContext[providerField];
    return typeof providerValue === 'string' ? providerValue.trim() : '';
  }

  function buildSelectOptions(field: any): Array<{ value: string; label: string }> {
    return (field.options || []).map((option: any) => ({
      value: option.value,
      label: $_(option.label)
    }));
  }
</script>

<div class="space-y-4">
  {#each schema as field (field.name)}
    {#if typeof field?.name === 'string' ? visibleFieldNames.has(field.name) : true}
      <div class="space-y-1.5">
        {#if field.type !== 'boolean'}
          <label class="font-mono text-[11px] uppercase tracking-command text-zinc-400 block" for={field.name}>
            // {$_(field.label)}
            {#if field.required}
              <span class="text-red-400">*</span>
            {/if}
          </label>
        {/if}

        {#if field.type === 'string'}
          <Input
            id={field.name}
            type="text"
            class={errors[field.name] ? 'border-red-500 focus:border-red-500' : ''}
            placeholder={field.placeholder ? $_(field.placeholder) : undefined}
            data-testid={field.required ? 'plugin-config-required-input' : undefined}
            value={getFieldValue(field) ?? ''}
            oninput={(e) => handleChange(field.name, (e.target as HTMLInputElement).value)}
            onblur={() => handleBlur(field)}
          />

        {:else if field.type === 'number'}
          <Input
            id={field.name}
            type="number"
            class={errors[field.name] ? 'border-red-500 focus:border-red-500' : ''}
            placeholder={field.placeholder ? $_(field.placeholder) : undefined}
            data-testid={field.required ? 'plugin-config-required-input' : undefined}
            value={getFieldValue(field) ?? ''}
            oninput={(e) => handleChange(field.name, parseFloat((e.target as HTMLInputElement).value))}
            onblur={() => handleBlur(field)}
          />

        {:else if field.type === 'boolean'}
          <BCheckbox
            checked={!!formattedValues[field.name]}
            label={$_(field.label)}
            onchange={(v) => handleChange(field.name, v)}
          />

        {:else if field.type === 'select'}
          <BSelect
            options={buildSelectOptions(field)}
            value={getFieldValue(field) ?? ''}
            placeholder={$_('common.select')}
            onchange={(v) => { handleChange(field.name, v); handleBlur(field); }}
          />

        {:else if field.type === 'multiselect'}
          <BSelect
            options={buildSelectOptions(field)}
            multiple={true}
            values={formattedValues[field.name] || []}
            placeholder={$_('common.select')}
            onchange={(v) => { handleChange(field.name, v); handleBlur(field); }}
          />

        {:else if field.type === 'textarea'}
          <Textarea
            id={field.name}
            class={errors[field.name] ? 'border-red-500 focus:border-red-500' : ''}
            placeholder={field.placeholder ? $_(field.placeholder) : undefined}
            data-testid={field.required ? 'plugin-config-required-input' : undefined}
            rows="4"
            value={getFieldValue(field) ?? ''}
            oninput={(e) => handleChange(field.name, (e.target as HTMLTextAreaElement).value)}
            onblur={() => handleBlur(field)}
          />

        {:else if field.type === 'json'}
          <Textarea
            id={field.name}
            class={errors[field.name] ? 'border-red-500 focus:border-red-500' : ''}
            placeholder={field.placeholder ? $_(field.placeholder) : '{}'}
            data-testid={field.required ? 'plugin-config-required-input' : undefined}
            rows="6"
            value={JSON.stringify(formattedValues[field.name] || {}, null, 2)}
            oninput={(e) => {
              try {
                const parsed = JSON.parse((e.target as HTMLTextAreaElement).value);
                handleChange(field.name, parsed);
              } catch (err) {
                // Invalid JSON, don't update
              }
            }}
            onblur={() => handleBlur(field)}
          />

        {:else if field.type === 'model_mapping'}
          <ModelMappingEditor
            value={Array.isArray(formattedValues[field.name]) ? formattedValues[field.name] : []}
            pluginName={pluginName}
            catalogPlugin={resolveModelCatalogPlugin(field)}
            sourceCatalogProvider={resolveModelCatalogProvider(field, 'sourceCatalogProviderField')}
            targetCatalogProvider={resolveModelCatalogProvider(field, 'targetCatalogProviderField')}
            on:change={(event) => {
              handleChange(field.name, event.detail);
              handleBlur(field);
            }}
          />
        {/if}

        {#if field.description}
          <p class="text-xs text-zinc-500">{$_(field.description)}</p>
        {/if}

        {#if errors[field.name]}
          <p class="font-mono text-[10px] uppercase tracking-command text-red-300" data-testid="plugin-config-validation-message">{errors[field.name]}</p>
        {/if}
      </div>
    {/if}
  {/each}
</div>
