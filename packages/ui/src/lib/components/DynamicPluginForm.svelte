<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { _ } from '../i18n';
  import { createParser, createFormatter, isVirtualField } from '../utils/field-transform';
  import ModelMappingEditor from './ModelMappingEditor.svelte';

  export let schema: any[] = [];
  export let value: Record<string, any> = {};
  export let errors: Record<string, string> = {};
  export let pluginName = '';

  const dispatch = createEventDispatcher();

  // 🔑 计算格式化后的字段值（用于显示）
  $: formattedValues = schema.reduce((acc, field) => {
    if (field.fieldTransform) {
      // 使用转换引擎生成 formatter
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

  // 🔑 获取字段的显示值
  function getFieldValue(field: any) {
    return formattedValues[field.name] ?? '';
  }

  // 🔑 处理字段变化（支持 fieldTransform）
  function handleChange(fieldName: string, newValue: any) {
    const field = schema.find(f => f.name === fieldName);

    if (field?.fieldTransform) {
      // 使用转换引擎生成 parser
      const parser = createParser(field.fieldTransform);
      if (parser) {
        const parsed = parser(newValue, value);

        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          // parse 返回对象 → 虚拟字段，展开为多个实际字段
          const nextValue = { ...value, ...parsed };
          delete nextValue[fieldName];  // 删除虚拟字段本身
          value = nextValue;
        } else {
          // parse 返回单值 → 普通字段转换
          value = { ...value, [fieldName]: parsed };
        }
      } else {
        // 无有效 parser → 直接保存
        value = { ...value, [fieldName]: newValue };
      }
    } else {
      // 无 fieldTransform → 直接保存
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
    // 🔑 虚拟字段：验证其对应的实际字段
    if (isVirtualField(field)) {
      if (field.required && field.fieldTransform?.fields) {
        const missingFields = field.fieldTransform.fields.filter(
          (realField: string) => !value[realField]
        );
        if (missingFields.length > 0) {
          return `${field.label} is required`;
        }
      }
      return null;  // 虚拟字段不进行其他验证
    }

    // 普通字段：原有验证逻辑
    const isEmptyArray = Array.isArray(val) && val.length === 0;
    if (field.required && (val === undefined || val === null || val === '' || isEmptyArray)) {
      return `${field.label} is required`;
    }

    if (field.validation) {
      const { pattern, min, max, message } = field.validation;

      if (pattern && typeof val === 'string') {
        const regex = new RegExp(pattern);
        if (!regex.test(val)) {
          return message || `Invalid format for ${field.label}`;
        }
      }

      if (min !== undefined) {
        const numVal = typeof val === 'number' ? val : (typeof val === 'string' ? val.length : 0);
        if (numVal < min) {
          return message || `${field.label} must be at least ${min}`;
        }
      }

      if (max !== undefined) {
        const numVal = typeof val === 'number' ? val : (typeof val === 'string' ? val.length : 0);
        if (numVal > max) {
          return message || `${field.label} must be at most ${max}`;
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
</script>

<div class="space-y-4">
  {#each schema as field (field.name)}
    {#if typeof field?.name === 'string' ? visibleFieldNames.has(field.name) : true}
      <div class="form-control">
        <label class="label" for={field.name}>
          <span class="label-text font-semibold">
            {$_(field.label)}
            {#if field.required}
              <span class="text-error">*</span>
            {/if}
          </span>
        </label>

        {#if field.type === 'string'}
          <input
            id={field.name}
            type="text"
            class="input input-bordered"
            class:input-error={errors[field.name]}
            placeholder={field.placeholder}
            value={getFieldValue(field)}
            on:input={(e) => handleChange(field.name, e.currentTarget.value)}
            on:blur={() => handleBlur(field)}
          />

        {:else if field.type === 'number'}
          <input
            id={field.name}
            type="number"
            class="input input-bordered"
            class:input-error={errors[field.name]}
            placeholder={field.placeholder}
            value={getFieldValue(field)}
            on:input={(e) => handleChange(field.name, parseFloat(e.currentTarget.value))}
            on:blur={() => handleBlur(field)}
          />

        {:else if field.type === 'boolean'}
          <input
            id={field.name}
            type="checkbox"
            class="toggle toggle-primary"
            checked={formattedValues[field.name] || false}
            on:change={(e) => handleChange(field.name, e.currentTarget.checked)}
          />

        {:else if field.type === 'select'}
          <select
            id={field.name}
            class="select select-bordered"
            class:select-error={errors[field.name]}
            value={getFieldValue(field)}
            on:change={(e) => handleChange(field.name, e.currentTarget.value)}
            on:blur={() => handleBlur(field)}
          >
            <option value="">-- Select --</option>
            {#each field.options || [] as option}
              <option value={option.value}>{$_(option.label)}</option>
            {/each}
          </select>

        {:else if field.type === 'multiselect'}
          <select
            id={field.name}
            class="select select-bordered"
            class:select-error={errors[field.name]}
            multiple
            value={formattedValues[field.name] || []}
            on:change={(e) => {
              const selected = Array.from(e.currentTarget.selectedOptions).map(opt => opt.value);
              handleChange(field.name, selected);
            }}
            on:blur={() => handleBlur(field)}
          >
            {#each field.options || [] as option}
              <option value={option.value}>{$_(option.label)}</option>
            {/each}
          </select>

        {:else if field.type === 'textarea'}
          <textarea
            id={field.name}
            class="textarea textarea-bordered"
            class:textarea-error={errors[field.name]}
            placeholder={field.placeholder}
            rows="4"
            value={getFieldValue(field)}
            on:input={(e) => handleChange(field.name, e.currentTarget.value)}
            on:blur={() => handleBlur(field)}
          ></textarea>

        {:else if field.type === 'json'}
          <textarea
            id={field.name}
            class="textarea textarea-bordered font-mono text-xs"
            class:textarea-error={errors[field.name]}
            placeholder={field.placeholder || '{}'}
            rows="6"
            value={JSON.stringify(formattedValues[field.name] || {}, null, 2)}
            on:input={(e) => {
              try {
                const parsed = JSON.parse(e.currentTarget.value);
                handleChange(field.name, parsed);
              } catch (err) {
                // Invalid JSON, don't update
              }
            }}
            on:blur={() => handleBlur(field)}
          ></textarea>

        {:else if field.type === 'model_mapping'}
          <ModelMappingEditor
            value={Array.isArray(formattedValues[field.name]) ? formattedValues[field.name] : []}
            pluginName={pluginName}
            catalogPlugin={resolveModelCatalogPlugin(field)}
            on:change={(event) => {
              handleChange(field.name, event.detail);
              handleBlur(field);
            }}
          />
        {/if}

        {#if field.description}
          <div class="label">
            <span class="label-text-alt text-gray-500">{$_(field.description)}</span>
          </div>
        {/if}

        {#if errors[field.name]}
          <div class="label">
            <span class="label-text-alt text-error">{errors[field.name]}</span>
          </div>
        {/if}
      </div>
    {/if}
  {/each}
</div>
