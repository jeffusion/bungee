type ShowIfCondition =
  | {
    field: string;
    value: unknown;
  }
  | {
    all: ShowIfCondition[];
  }
  | {
    any: ShowIfCondition[];
  };

interface SchemaFieldLike {
  name?: unknown;
  showIf?: ShowIfCondition;
}

export function shouldShowField(field: SchemaFieldLike, config: Record<string, unknown>): boolean {
  if (!field.showIf) return true;
  return matchesShowCondition(field.showIf, config);
}

function matchesShowCondition(condition: ShowIfCondition, config: Record<string, unknown>): boolean {
  if ('all' in condition) {
    return condition.all.every(item => matchesShowCondition(item, config));
  }

  if ('any' in condition) {
    return condition.any.some(item => matchesShowCondition(item, config));
  }

  return config[condition.field] === condition.value;
}

export function hasDisplayValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function collectSchemaFieldNames(schema: SchemaFieldLike[]): Set<string> {
  return new Set(
    schema
      .map(field => field.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)
  );
}

export function shouldRenderFallbackField(
  key: string,
  value: unknown,
  processedFields: Set<string>,
  schemaFieldNames: Set<string>
): boolean {
  return !processedFields.has(key) && hasDisplayValue(value) && !schemaFieldNames.has(key);
}

/** Structured option values must never rely on object-to-string coercion. */
export function displayConfigValue(value: unknown): string {
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function displayModelBindings(value: unknown, targetLabel: (type: 'route' | 'service') => string): string {
  if (!Array.isArray(value)) return displayConfigValue(value);
  return value.map(binding => {
    if (!binding || typeof binding !== 'object') return displayConfigValue(binding);
    const source = binding.source ?? binding.alias ?? binding.model;
    const destination = `${binding.provider}/${binding.model}`;
    const target = binding.target;
    const protocolNames: Record<string, string> = { responses: 'Responses', chat_completions: 'Chat Completions', anthropic_messages: 'Anthropic Messages' };
    const protocol = target?.protocol ? ` · ${protocolNames[target.protocol] ?? target.protocol}` : '';
    const forwarding = target && ['route', 'service'].includes(target.type) ? ` · ${targetLabel(target.type)}: ${target.id}` : '';
    return `${source} → ${destination}${protocol}${forwarding}`;
  }).join('\n');
}
