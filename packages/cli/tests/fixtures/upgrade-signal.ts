import { getAssetName } from '../../../core/src/updates/names';
import { RELEASE_API } from '../../../core/src/updates/release';
import { upgradeCommand } from '../../src/commands/upgrade';

const asset = getAssetName();
const url = `https://github.com/jeffusion/bungee/releases/download/v6.6.1/${asset}`;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input) === RELEASE_API) return Response.json({ tag_name: 'v6.6.1', draft: false, prerelease: false,
    published_at: '2026-10-26T00:00:00Z', html_url: 'https://github.com/jeffusion/bungee/releases/tag/v6.6.1',
    assets: [{ name: asset, state: 'uploaded', size: 128, digest: `sha256:${'0'.repeat(64)}`, browser_download_url: url }] });
  if (String(input) !== url || !init?.signal) throw new Error('Unexpected fixture update request');
  console.log('archive-requested');
  return new Promise<Response>((_resolve, reject) => {
    init.signal!.throwIfAborted();
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  });
}) as typeof fetch;
await upgradeCommand();
