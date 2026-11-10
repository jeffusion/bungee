import { DataAdmissionError } from '@jeffusion/bungee-core/plugin';

function matches(name: string, parts: string[]): boolean {
  const first = parts[0]!;
  if (parts.length === 1) return name === first;
  const last = parts.at(-1)!;
  if (!name.startsWith(first) || !name.endsWith(last)) return false;
  let offset = first.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const index = name.indexOf(part, offset);
    if (index < 0) return false;
    offset = index + part.length;
  }
  return offset <= name.length - last.length;
}

type Payload = Record<string, unknown>;
const isObject = (value: unknown): value is Payload => value !== null && typeof value === 'object' && !Array.isArray(value);

export function applyToolAllowlist(body: Payload, input: unknown[], allowlist: string): unknown[] {
  const entries = allowlist.split(',').map(pattern => pattern.trim()).filter(Boolean);
  if (entries.some(pattern => /^\*+$/.test(pattern))) return input;
  const patterns = entries.map(pattern => pattern.split('*'));
  const allows = (name: unknown, namespace?: unknown) => {
    if (typeof name !== 'string' || (namespace !== undefined && typeof namespace !== 'string')) return true;
    const qualified = namespace === undefined ? name : `${namespace}.${name}`;
    return patterns.some(pattern => matches(qualified, pattern));
  };
  const allowsTool = (tool: Payload, namespace?: unknown) => tool.type === 'function' || tool.type === 'custom'
    ? allows(tool.name, namespace) : allows(tool.type, namespace);
  const filter = (tools: unknown[]): unknown[] => tools.flatMap(tool => {
    if (!isObject(tool) || typeof tool.type !== 'string') return [tool];
    if (tool.type !== 'namespace') return allowsTool(tool) ? [tool] : [];
    if (typeof tool.name !== 'string' || !Array.isArray(tool.tools)) return [tool];
    const children = tool.tools.filter(child => !isObject(child) || allowsTool(child, tool.name));
    return children.length ? [{ ...tool, tools: children }] : [];
  });

  const choice = body.tool_choice;
  const selected = isObject(choice) && choice.type === 'allowed_tools' && Array.isArray(choice.tools) ? choice.tools : [choice];
  if (selected.some(tool => isObject(tool) && typeof tool.type === 'string' && !allowsTool(tool, tool.namespace)))
    throw new DataAdmissionError(422, 'codex_router_tool_choice_excluded', undefined, { param: 'tool_choice', message: 'The selected tool is excluded by the model binding' });

  if (Array.isArray(body.tools)) {
    const tools = filter(body.tools);
    if (tools.length) body.tools = tools;
    else delete body.tools;
  }
  let hasTools = body.tools !== undefined;
  const filteredInput = input.flatMap((item, index) => {
    if (!isObject(item)) return [item];
    const { type } = item;
    const historicalToolAllowed = type === 'function_call' || type === 'custom_tool_call' ? allows(item.name, item.namespace)
      : type === 'web_search_call' ? ['web_search', 'web_search_preview', 'web_search_preview_2025_03_11'].some(name => allows(name))
      : type === 'computer_call' ? ['computer', 'computer_use_preview'].some(name => allows(name))
      : typeof type === 'string' && type.endsWith('_call') ? allows(type.slice(0, -5)) : true;
    if (!historicalToolAllowed || type === 'item_reference')
      throw new DataAdmissionError(422, 'codex_router_tool_history_excluded', undefined, { param: `input[${index}]`, message: 'Tool history is excluded by the model binding. Start a new conversation or allow the tool.' });
    if ((item.type !== 'additional_tools' && item.type !== 'tool_search_output') || !Array.isArray(item.tools)) return [item];
    const declarations = filter(item.tools);
    if (!declarations.length && item.type === 'additional_tools' && item.content === undefined) return [];
    hasTools ||= declarations.length > 0;
    return [{ ...item, tools: declarations }];
  });
  if (!hasTools) {
    if (choice === 'required')
      throw new DataAdmissionError(422, 'codex_router_tool_choice_excluded', undefined, { param: 'tool_choice', message: 'The model binding leaves no tools to call' });
    if (choice === 'auto' || choice === 'none') delete body.tool_choice;
    if (typeof body.parallel_tool_calls === 'boolean') delete body.parallel_tool_calls;
  }
  if (Array.isArray(body.input)) body.input = filteredInput;
  return filteredInput;
}
