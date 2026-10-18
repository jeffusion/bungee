import type { Database } from 'bun:sqlite';
import type { MenuLayout, MenuLayoutRecord } from '@jeffusion/bungee-types';
import { ConfigRepositoryError } from './repository-types';
import { menuPageIds, validateMenuLayout } from '../ui/menu-layout';

export type MenuLayoutCommit =
  | { readonly kind: 'committed'; readonly record: MenuLayoutRecord }
  | { readonly kind: 'stale_revision'; readonly record: MenuLayoutRecord };
export function readMenuLayout(db: Database): MenuLayoutRecord {
  const row = db.query<{revision: number; layout_json: string | null}, []>('SELECT revision,layout_json FROM ui_menu_layout WHERE id=1').get();
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0 || (row.revision === 0) !== (row.layout_json === null)) throw new ConfigRepositoryError('schema_corrupt', 'menu singleton is invalid');
  try {
    // A removed icon is an editable resource failure, not database corruption.
    const layout = row.layout_json === null ? null : validateMenuLayout(JSON.parse(row.layout_json), undefined, false);
    if (layout !== null && JSON.stringify(layout) !== row.layout_json) throw new Error('noncanonical menu record');
    return { revision: row.revision, layout };
  } catch (error) { throw new ConfigRepositoryError('schema_corrupt', 'stored menu layout is invalid', error); }
}
/** Caller owns an IMMEDIATE transaction: compare, validate and write have one authority. */
export function writeMenuLayout(db: Database, expectedRevision: number, layout: MenuLayout, catalogPageIds: readonly string[]): MenuLayoutCommit {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER
    || !Array.isArray(catalogPageIds) || catalogPageIds.length > 512 || catalogPageIds.some(id => typeof id !== 'string' || id.length > 512)) {
    throw new ConfigRepositoryError('invalid_command', 'invalid menu command');
  }
  const active = readMenuLayout(db);
  if (active.revision !== expectedRevision) return { kind: 'stale_revision', record: active };
  let canonical: MenuLayout;
  try { canonical = validateMenuLayout(layout, new Set([...catalogPageIds, ...menuPageIds(active.layout)])); }
  catch (error) { throw new ConfigRepositoryError('invalid_command', 'invalid menu layout', error); }
  const revision = active.revision + 1;
  db.run('UPDATE ui_menu_layout SET revision=?,layout_json=? WHERE id=1 AND revision=?', [revision, JSON.stringify(canonical), expectedRevision]);
  return { kind: 'committed', record: { revision, layout: canonical } };
}
