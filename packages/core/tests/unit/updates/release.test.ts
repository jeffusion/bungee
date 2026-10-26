import { describe, expect, test } from 'bun:test';
import { compareVersions, parseRelease, parseVersion, RELEASE_API } from '../../../src/updates/release';
import { getAssetName } from '../../../src/updates/names';

function release() {
  const asset = getAssetName();
  return { tag_name: 'v6.7.0', draft: false, prerelease: false, published_at: '2026-10-26T00:00:00Z',
    html_url: 'https://github.com/jeffusion/bungee/releases/tag/v6.7.0',
    assets: [{ name: asset, state: 'uploaded', size: 100, digest: `sha256:${'a'.repeat(64)}`,
      browser_download_url: `https://github.com/jeffusion/bungee/releases/download/v6.7.0/${asset}` }] };
}

describe('official update releases', () => {
  test('compares numeric version components without lexical ordering or silent rewrites', () => {
    expect(compareVersions('6.10.0', '6.9.9')).toBe(1);
    expect(compareVersions('7.0.0', '7.0.0')).toBe(0);
    expect(compareVersions('6.9.0', '7.0.0')).toBe(-1);
    for (const value of ['v6.7.0','06.7.0','6.7.0-beta','../6.7.0','6.7','6.7.9007199254740992']) expect(() => parseVersion(value)).toThrow();
  });
  test('accepts only official stable release identities and exact platform assets', () => {
    expect(RELEASE_API).toBe('https://api.github.com/repos/jeffusion/bungee/releases/latest');
    expect(parseRelease(release()).asset?.size).toBe(100);
    expect(() => parseRelease({ ...release(), prerelease: true })).toThrow();
    expect(() => parseRelease({ ...release(), draft: true })).toThrow();
    expect(() => parseRelease({ ...release(), html_url: 'https://other.example/release' })).toThrow();
  });
  test('incomplete, missing, oversized or unverified assets remain unavailable', () => {
    expect(parseRelease({ ...release(), assets: [] }).asset).toBeNull();
    for (const patch of [{ state: 'new' }, { digest: null }, { size: 1024 ** 3 }, { browser_download_url: 'https://other.example/package.tar.gz' }]) {
      const value = release(); Object.assign(value.assets[0]!, patch);
      expect(parseRelease(value).asset).toBeNull();
    }
  });
});
