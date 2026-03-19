<script lang="ts">
  import { _ } from '../i18n';
  import { createFormatter, isVirtualField } from '../utils/field-transform';
  import {
    collectSchemaFieldNames,
    hasDisplayValue,
    shouldRenderFallbackField,
    shouldShowField,
  } from './plugin-config-display-utils';

  /**
   * 通用的插件配置展示组件
   *
   * 功能：
   * 1. 智能地格式化显示插件参数
   * 2. 支持虚拟字段的反向展示
   * 3. 使用翻译系统翻译标签和选项
   * 4. 适用于所有插件
   */
  export let schema: any[] = [];
  export let config: Record<string, any> = {};

  interface DisplayItem {
    label: string;
    value: string;
  }

  $: displayItems = formatConfigForDisplay(schema, config);

  /**
   * 格式化配置为可显示的项列表
   */
  function formatConfigForDisplay(schema: any[], config: Record<string, any>): DisplayItem[] {
    if (!schema || schema.length === 0 || !config || Object.keys(config).length === 0) {
      return [];
    }

    const items: DisplayItem[] = [];
    const processedFields = new Set<string>();
    const schemaFieldNames = collectSchemaFieldNames(schema);

    for (const field of schema) {
      // 虚拟字段：使用 formatter 将实际字段值转换回虚拟字段显示格式
      if (isVirtualField(field)) {
        const formatter = field.fieldTransform ? createFormatter(field.fieldTransform) : null;

        if (formatter) {
          const virtualValue = formatter(null, config);

          if (virtualValue) {
            const displayValue = formatFieldValue(field, virtualValue);
            items.push({
              label: $_(field.label),
              value: displayValue
            });

            // 标记虚拟字段对应的实际字段为已处理
            if (field.fieldTransform?.fields) {
              field.fieldTransform.fields.forEach((f: string) => processedFields.add(f));
            }
          }
        }
      }
      // 普通字段
      else if (hasDisplayValue(config[field.name]) && !processedFields.has(field.name) && shouldShowField(field, config)) {
        const displayValue = formatFieldValue(field, config[field.name]);
        items.push({
          label: $_(field.label),
          value: displayValue
        });
        processedFields.add(field.name);
      }
    }

    // 处理 schema 中未定义但存在于 config 中的字段
    for (const [key, value] of Object.entries(config)) {
      if (shouldRenderFallbackField(key, value, processedFields, schemaFieldNames)) {
        items.push({
          label: key,
          value: String(value)
        });
      }
    }

    return items;
  }

  /**
   * 根据字段类型格式化显示值
   */
  function formatFieldValue(field: any, value: any): string {
    // select: 显示翻译后的选项标签
    if (field.type === 'select' && field.options) {
      const option = field.options.find((opt: any) => opt.value === value);
      return option ? $_(option.label) : String(value);
    }

    // multiselect: 显示翻译后的选项标签列表
    if (field.type === 'multiselect' && field.options && Array.isArray(value)) {
      const labels = value.map(v => {
        const option = field.options.find((opt: any) => opt.value === v);
        return option ? $_(option.label) : String(v);
      });
      return labels.join(', ');
    }

    // boolean: 显示翻译后的是/否
    if (field.type === 'boolean') {
      return value ? $_('common.yes') : $_('common.no');
    }

    // json: 格式化 JSON
    if (field.type === 'json' && typeof value === 'object') {
      return JSON.stringify(value, null, 2);
    }

    // 其他类型：直接转字符串
    return String(value);
  }
</script>

{#if displayItems.length > 0}
  <div class="space-y-1">
    {#each displayItems as item}
      <div class="flex items-start gap-2 text-xs">
        <span class="text-gray-600 font-medium min-w-[80px]">{item.label}:</span>
        <span class="text-gray-700 flex-1">{item.value}</span>
      </div>
    {/each}
  </div>
{/if}
