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
