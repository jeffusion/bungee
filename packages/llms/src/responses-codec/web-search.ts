import { atParam, fail, list, record, string, type JsonRecord } from './common';

/** Validate a known hosted declaration before an explicitly permitted omission. */
export function validateWebSearch(tool: JsonRecord, path: string): void {
  const fields = (value: JsonRecord, allowed: readonly string[], at: string) => {
    for (const key of Object.keys(value))
      if (!allowed.includes(key)) fail('unsupported_tool', 'Unknown web search option', `${at}.${key}`);
  };
  const text = (value: unknown, at: string) => atParam(at, () => string(value, at, true));
  fields(tool, ['type', 'external_web_access', 'indexed_web_access', 'filters', 'user_location', 'search_context_size', 'search_content_types', 'return_token_budget'], path);
  for (const key of ['external_web_access', 'indexed_web_access'])
    if (tool[key] !== undefined && typeof tool[key] !== 'boolean')
      fail('invalid_payload', 'Web search access option must be boolean', `${path}.${key}`);
  if (tool.search_context_size !== undefined && (typeof tool.search_context_size !== 'string' || !['low', 'medium', 'high'].includes(tool.search_context_size)))
    fail('invalid_payload', 'Unknown web search context size', `${path}.search_context_size`);
  if (tool.return_token_budget !== undefined && (!Number.isSafeInteger(tool.return_token_budget) || (tool.return_token_budget as number) <= 0))
    fail('invalid_payload', 'Web search token budget must be a positive integer', `${path}.return_token_budget`);
  if (tool.search_content_types !== undefined) atParam(`${path}.search_content_types`, () => {
    const values = list(tool.search_content_types, 'search content types');
    if (!values.length || values.some(value => value !== 'text' && value !== 'image'))
      fail('invalid_payload', 'Unknown web search content type');
  });
  if (tool.filters != null) atParam(`${path}.filters`, () => {
    const filters = record(tool.filters, 'web search filters');
    fields(filters, ['allowed_domains', 'blocked_domains'], `${path}.filters`);
    for (const [key, value] of Object.entries(filters)) {
      if (value === null) continue;
      atParam(`${path}.filters.${key}`, () => list(value, 'domains').forEach((domain, i) => text(domain, `${path}.filters.${key}[${i}]`)));
    }
  });
  if (tool.user_location != null) atParam(`${path}.user_location`, () => {
    const location = record(tool.user_location, 'web search location');
    fields(location, ['type', 'country', 'region', 'city', 'timezone'], `${path}.user_location`);
    if (location.type !== 'approximate') fail('invalid_payload', 'Web search location must be approximate', `${path}.user_location.type`);
    for (const [key, value] of Object.entries(location)) text(value, `${path}.user_location.${key}`);
  });
}
