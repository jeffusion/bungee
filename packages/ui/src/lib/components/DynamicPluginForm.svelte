<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { _ } from '../i18n';
  import { createParser, createFormatter, isVirtualField } from '../utils/field-transform';

  export let schema: any[] = [];
  export let value: Record<string, any> = {};
  export let errors: Record<string, string> = {};

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
          value = { ...value, ...parsed };
          delete value[fieldName];  // 删除虚拟字段本身
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

    dispatch('change', value);
  }

  function shouldShow(field: any): boolean {
    if (!field.showIf) return true;
    return value[field.showIf.field] === field.showIf.value;
  }

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
    if (field.required && (val === undefined || val === null || val === '')) {
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
    dispatch('validate', errors);
  }
</script>

<div class="space-y-4">
  {#each schema as field}
    {#if shouldShow(field)}
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
