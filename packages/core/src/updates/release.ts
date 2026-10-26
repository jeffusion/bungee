import { getAssetName, getBinaryName } from './names';

export const RELEASE_REPOSITORY = 'jeffusion/bungee';
export const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export type ReleaseAsset = { url: string; size: number; digest: string };
export type UpdateRelease = { version: string; published_at: string; url: string; asset: ReleaseAsset | null };

export class UpdateError extends Error {
  constructor(readonly code: string, readonly status = 422) { super(code); }
}

export function parseVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    || value.split('.').some(part => !Number.isSafeInteger(Number(part)))) throw new UpdateError('invalid_version', 400);
  return value;
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left).split('.').map(Number), b = parseVersion(right).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

export function parseRelease(value: unknown, assetName = getAssetName()): UpdateRelease {
  if (!value || typeof value !== 'object') throw new UpdateError('invalid_release');
  const release = value as Record<string, unknown>;
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string'
    || !release.tag_name.startsWith('v') || typeof release.published_at !== 'string'
    || !Number.isFinite(Date.parse(release.published_at)) || !Array.isArray(release.assets)) throw new UpdateError('invalid_release');
  const version = parseVersion(release.tag_name.slice(1));
  const url = `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}`;
  if (release.html_url !== url) throw new UpdateError('invalid_release');
  const matches = release.assets.filter((item: any) => item?.name === assetName);
  if (matches.length > 1) throw new UpdateError('invalid_release');
  const item = matches[0];
  const expectedUrl = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/${assetName}`;
  const asset = item?.state === 'uploaded' && item.browser_download_url === expectedUrl
    && Number.isSafeInteger(item.size) && item.size > 0 && item.size <= MAX_ARCHIVE_BYTES
    && typeof item.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(item.digest)
    ? { url: expectedUrl, size: item.size as number, digest: item.digest as string } : null;
  return { version, published_at: release.published_at, url, asset };
}

export async function fetchLatestRelease(http: typeof fetch = fetch, binaryName = getBinaryName()): Promise<UpdateRelease> {
  const response = await http(RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Bungee-Updates' },
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  if (!response.ok) throw new UpdateError(response.status === 403 || response.status === 429 ? 'release_rate_limited' : 'release_check_failed', 503);
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) throw new UpdateError('invalid_release');
  try { return parseRelease(JSON.parse(text), getAssetName(binaryName)); }
  catch (error) { if (error instanceof UpdateError) throw error; throw new UpdateError('invalid_release'); }
}
