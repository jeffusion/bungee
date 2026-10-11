import type { CreatedKey } from '../../../packages/ui/src/api/keys';
import { ApiError } from '../../../packages/ui/src/api/client';
export function createdCredential(error: unknown): CreatedKey | null {
  if (!(error instanceof ApiError) || typeof error.body !== 'object' || error.body === null) return null;
  const body = error.body as Partial<CreatedKey>;
  return body.key && typeof body.token === 'string' ? body as CreatedKey : null;
}
export function publicationMessage(result: {ready?:boolean;published?:boolean}): string {
  return result.ready === false || result.published === false ? 'ui.publicationPending' : 'ui.publicationComplete';
}

export function keyApplied(routeId: string, keyId: string, unrestrictedKeyIds: readonly string[],
  routeKeyBindings: Readonly<Record<string, readonly { id: string }[]>>): boolean {
  return unrestrictedKeyIds.includes(keyId) || !!routeKeyBindings[routeId]?.some(key => key.id === keyId);
}

export type Message = { key: string; values?: Record<string, string | number | string[] | Message>; append?: Message };
export function renderMessage(value: Message | null, language: string | null | undefined,
  translate: (key: string, values: Record<string, string | number>) => string): string {
  if (!value) return '';
  const values = Object.fromEntries(Object.entries(value.values ?? {}).map(([key, item]) =>
    [key, Array.isArray(item) ? new Intl.ListFormat(language ?? undefined).format(item)
      : typeof item === 'object' ? renderMessage(item, language, translate) : item]));
  return [translate(value.key, values), value.append ? renderMessage(value.append, language, translate) : ''].filter(Boolean).join(' ');
}
