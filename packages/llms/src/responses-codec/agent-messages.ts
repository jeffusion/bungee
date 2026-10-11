import { isCollaborationFunction, atParam, fail, limits, list, record, serialized, string, type JsonRecord, type ResponsesCodecLimits, type ResponsesConversionDiagnostic } from './common';

export type AgentMessageDelivery = 'plaintext';
export interface AgentMessageInspection {
  inputIndex: number;
  author: string;
  recipient: string;
  encryptedContents: Array<{ contentIndex: number; param: string }>;
}
export interface AgentMessagePlaintextReplacement { param: string; text: string }
export interface AgentMessageInspectionResult {
  messages: AgentMessageInspection[];
  diagnostics: ResponsesConversionDiagnostic[];
}

function exact(value: JsonRecord, keys: string[], path: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key))
    fail('unsupported_content', 'Unknown agent message field', `${path}.${key}`);
}

/** Validate identities as metadata, never as instruction roles. Inspection permits opaque blocks only to locate them. */
export function validateAgentMessage(raw: unknown, path: string, configuredLimits?: Partial<ResponsesCodecLimits>, allowEncrypted = false): JsonRecord {
  const budget = limits(configuredLimits);
  const item = atParam(path, () => record(raw, 'agent message'));
  exact(item, ['type', 'id', 'author', 'recipient', 'content', 'internal_chat_message_metadata_passthrough'], path);
  if (item.type !== 'agent_message') fail('unsupported_content', 'Expected agent message', `${path}.type`);
  if (item.id !== undefined) atParam(`${path}.id`, () => string(item.id, 'agent message id', true));
  // Source annotations use the existing canonical-history omission rule. They
  // are never an identity/permission source or an instruction to the target.
  if (item.internal_chat_message_metadata_passthrough !== undefined)
    atParam(`${path}.internal_chat_message_metadata_passthrough`, () => record(item.internal_chat_message_metadata_passthrough, 'message metadata'));
  for (const key of ['author', 'recipient']) atParam(`${path}.${key}`, () => string(item[key], 'agent identity', true));
  const content = atParam(`${path}.content`, () => list(item.content, 'agent content'));
  if (content.length > budget.maxItems) fail('resource_limit', 'Too many agent content parts', `${path}.content`);
  for (const [index, rawPart] of content.entries()) {
    const partPath = `${path}.content[${index}]`;
    const part = atParam(partPath, () => record(rawPart, 'agent content part'));
    if (part.type === 'encrypted_content') {
      exact(part, ['type', 'encrypted_content'], partPath);
      atParam(`${partPath}.encrypted_content`, () => string(part.encrypted_content, 'encrypted content', true));
      if (!allowEncrypted) fail('unsupported_content', 'Encrypted agent content requires explicit plaintext replacement', `${partPath}.encrypted_content`);
    } else {
      exact(part, ['type', 'text'], partPath);
      if (part.type !== 'input_text') fail('unsupported_content', 'Agent messages require input text', `${partPath}.type`);
      atParam(`${partPath}.text`, () => string(part.text, 'agent input text'));
    }
  }
  atParam(path, () => serialized(item, budget.maxRequestBytes, 'agent message'));
  return item;
}

/** Pure bounded inspection. Neither plaintext nor opaque content is returned in diagnostics. */
export function inspectAgentMessages(raw: unknown, options: { limits?: Partial<ResponsesCodecLimits> } = {}): AgentMessageInspectionResult {
  const budget = limits(options.limits);
  const body = atParam('request', () => record(raw, 'request'));
  atParam('request', () => serialized(body, budget.maxRequestBytes, 'request'));
  const input = typeof body.input === 'string' ? [] : atParam('input', () => list(body.input, 'input'));
  if (input.length > budget.maxItems) fail('resource_limit', 'Too many input items', 'input');
  const messages: AgentMessageInspection[] = [], diagnostics: ResponsesConversionDiagnostic[] = [];
  let parts = 0;
  for (const [inputIndex, rawItem] of input.entries()) {
    const item = atParam(`input[${inputIndex}]`, () => record(rawItem, 'input item'));
    if (item.type !== 'agent_message') continue;
    validateAgentMessage(item, `input[${inputIndex}]`, options.limits, true);
    const encryptedContents: AgentMessageInspection['encryptedContents'] = [];
    for (const [contentIndex, part] of (item.content as JsonRecord[]).entries()) {
      if (++parts > budget.maxItems) fail('resource_limit', 'Too many agent content parts', 'input');
      if (part.type === 'encrypted_content') {
        const param = `input[${inputIndex}].content[${contentIndex}].encrypted_content`;
        encryptedContents.push({ contentIndex, param });
      }
    }
    messages.push({ inputIndex, author: item.author as string, recipient: item.recipient as string, encryptedContents });
  }
  return { messages, diagnostics };
}

/** Replace only explicitly selected agent opaque blocks, at their original positions. Other history is untouched. */
export function replaceAgentMessageEncryptedContent(raw: unknown, replacements: readonly AgentMessagePlaintextReplacement[], options: { limits?: Partial<ResponsesCodecLimits> } = {}): { body: JsonRecord; diagnostics: ResponsesConversionDiagnostic[] } {
  const inspection = inspectAgentMessages(raw, options);
  const budget = limits(options.limits);
  if (!Array.isArray(replacements)) fail('invalid_payload', 'Replacements must be an array', 'replacements');
  if (replacements.length > budget.maxItems) fail('resource_limit', 'Too many replacements', 'replacements');
  const locations = new Map(inspection.messages.flatMap(m => m.encryptedContents.map(c => [c.param, { inputIndex: m.inputIndex, contentIndex: c.contentIndex }] as const)));
  const selected = new Set<string>();
  let body: JsonRecord;
  try { body = structuredClone(record(raw, 'request')); }
  catch { fail('invalid_payload', 'Request must be cloneable JSON', 'request'); }
  const diagnostics: ResponsesConversionDiagnostic[] = [];
  for (const [i, rawReplacement] of replacements.entries()) {
    const replacement = atParam(`replacements[${i}]`, () => record(rawReplacement, 'replacement'));
    exact(replacement, ['param', 'text'], `replacements[${i}]`);
    const param = atParam(`replacements[${i}].param`, () => string(replacement.param, 'replacement param', true));
    const text = atParam(`replacements[${i}].text`, () => string(replacement.text, 'replacement text'));
    const location = locations.get(param);
    if (!location || selected.has(param)) fail('invalid_payload', 'Replacement must identify one unique encrypted agent content block', `replacements[${i}].param`);
    selected.add(param);
    (record((body.input as unknown[])[location.inputIndex], 'agent message').content as unknown[])[location.contentIndex] = { type: 'input_text', text };
    diagnostics.push({ param, action: 'mapped', reason: 'agent_message_plaintext_replacement' });
  }
  atParam('request', () => serialized(body, budget.maxRequestBytes, 'request'));
  return { body, diagnostics };
}

export function validateEncryptedFunctionArgs(item: JsonRecord, delivery: AgentMessageDelivery | undefined, path: string): void {
  if (item.encrypted_function_args === undefined) return;
  const param = `${path}.encrypted_function_args`;
  if (delivery !== 'plaintext' || !isCollaborationFunction(item.name, item.namespace, item.type !== 'function_call'))
    fail('unsupported_content', 'Encrypted function argument marker is unavailable for this tool', param);
  const values = atParam(param, () => list(item.encrypted_function_args, 'encrypted function arguments'));
  if (values.length) fail('unsupported_content', 'Encrypted function arguments cannot cross protocols', param);
}
