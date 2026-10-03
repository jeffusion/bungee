export const UNATTRIBUTED_KEY_ID = '__unattributed__';

/** Hash-route query takes precedence; regular query supports direct page URLs too. */
export function keyIdFromUrl(value: string): string {
  const url = new URL(value, 'http://localhost');
  const hashQuery = url.hash.includes('?') ? url.hash.slice(url.hash.indexOf('?') + 1) : '';
  return new URLSearchParams(hashQuery).get('keyId') ?? url.searchParams.get('keyId') ?? '';
}

export function urlWithKeyId(value: string, keyId: string): string {
  const url = new URL(value, 'http://localhost');
  // Clear a stale regular query so selecting all actually removes the filter.
  url.searchParams.delete('keyId');
  if (url.hash.startsWith('#/')) {
    const [path, query = ''] = url.hash.slice(1).split('?');
    const params = new URLSearchParams(query);
    if (keyId) params.set('keyId', keyId); else params.delete('keyId');
    url.hash = `${path}${params.size ? `?${params}` : ''}`;
  } else if (keyId) url.searchParams.set('keyId', keyId);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function keyFilterOptions(keys: readonly { id: string; name: string }[], selected: string,
  labels: { all: string; unattributed: string; missing: string }) {
  return [
    { value: '', label: labels.all },
    { value: UNATTRIBUTED_KEY_ID, label: labels.unattributed },
    ...keys.map(key => ({ value: key.id, label: key.name })),
    ...(selected && selected !== UNATTRIBUTED_KEY_ID && !keys.some(key => key.id === selected)
      ? [{ value: selected, label: labels.missing }] : []),
  ];
}
