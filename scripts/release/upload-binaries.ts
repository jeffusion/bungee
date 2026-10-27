#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const API = 'https://api.github.com';
const REPOSITORY = 'jeffusion/bungee';

type Release = {
  readonly id: number;
  readonly upload_url: string;
};

type Asset = {
  readonly id: number;
  readonly name: string;
  readonly state: string;
  readonly size: number;
  readonly digest: string | null;
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function release(value: unknown): Release {
  if (!object(value) || typeof value.id !== 'number' || typeof value.upload_url !== 'string') {
    throw new Error('GitHub returned an invalid release');
  }
  return { id: value.id, upload_url: value.upload_url };
}

function assets(value: unknown): readonly Asset[] {
  if (!Array.isArray(value)) throw new Error('GitHub returned an invalid asset list');
  return value.map((item) => {
    if (!object(item) || typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id <= 0
      || typeof item.name !== 'string' || typeof item.state !== 'string'
      || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0
      || (item.digest !== null && (typeof item.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.digest)))) {
      throw new Error('GitHub returned an invalid asset');
    }
    return { id: item.id, name: item.name, state: item.state, size: item.size, digest: item.digest };
  });
}

export function selectBinaryArchives(directory: string): readonly string[] {
  if (!existsSync(directory)) throw new Error(`Binary directory not found: ${directory}`);
  return readdirSync(directory)
    .filter((name) => name.startsWith('bungee-') && name.endsWith('.tar.gz'))
    .filter((name) => statSync(join(directory, name)).isFile())
    .sort();
}

async function github(token: string, endpoint: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${API}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw await responseError('GitHub API', response);
  return response.json();
}

async function responseError(context: string, response: Response): Promise<Error> {
  return new Error(`${context}: HTTP ${response.status}, request ${response.headers.get('x-github-request-id') ?? 'unknown'}: ${await response.text()}`);
}

async function getOrCreateRelease(token: string, version: string): Promise<Release> {
  const tag = `v${version}`;
  const existing = await fetch(`${API}/repos/${REPOSITORY}/releases/tags/${tag}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000),
  });
  if (existing.ok) return release(await existing.json());
  if (existing.status !== 404) throw await responseError('GitHub API', existing);
  return release(await github(token, `/repos/${REPOSITORY}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: tag, body: `Release ${tag}`, draft: false, prerelease: false }),
  }));
}

async function findAsset(token: string, releaseId: number, name: string): Promise<Asset | undefined> {
  for (let page = 1; ; page++) {
    const entries = assets(await github(token, `/repos/${REPOSITORY}/releases/${releaseId}/assets?per_page=100&page=${page}`));
    const existing = entries.find((asset) => asset.name === name);
    if (existing || entries.length < 100) return existing;
  }
}

async function checkExistingAsset(token: string, releaseId: number, name: string, size: number, digest: string): Promise<boolean> {
  const existing = await findAsset(token, releaseId, name);
  if (existing === undefined) return false;
  if (existing.state === 'uploaded' && existing.size === size && existing.digest === digest) return true;
  if (existing.state !== 'starter' || existing.size !== 0) {
    throw new Error(`Release asset ${name} exists but does not match the local archive; refusing to replace it`);
  }
  const response = await fetch(`${API}/repos/${REPOSITORY}/releases/assets/${existing.id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw await responseError(`Failed to delete empty starter ${name}`, response);
  return false;
}

export async function uploadBinaryArchive(token: string, targetRelease: Release, filePath: string, name: string): Promise<void> {
  const size = statSync(filePath).size;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  const digest = `sha256:${hash.digest('hex')}`;
  if (await checkExistingAsset(token, targetRelease.id, name, size, digest)) return;

  for (let attempt = 1; attempt <= 3; attempt++) {
    let failure: Error;
    let retryable = true;
    try {
      const response = await fetch(targetRelease.upload_url.replace('{?name,label}', `?name=${encodeURIComponent(name)}`), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/gzip',
          'Content-Length': String(size),
        },
        body: Bun.file(filePath),
        signal: AbortSignal.timeout(300_000),
      });
      retryable = response.status >= 500 && response.status <= 599;
      if (response.ok) {
        await response.arrayBuffer();
        return;
      }
      failure = await responseError(`Failed to upload ${name}`, response);
    } catch (error) {
      failure = new Error(`Failed to upload ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // A failed response can arrive after GitHub has already stored the archive.
    try {
      if (await checkExistingAsset(token, targetRelease.id, name, size, digest)) return;
    } catch (error) {
      throw new Error(`${failure.message}; upload verification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!retryable || attempt === 3) throw failure;
    console.warn(`${failure.message}; retrying upload (${attempt + 1}/3)`);
    await Bun.sleep(attempt * 1000);
  }
}

async function main(): Promise<void> {
  const version = process.argv[2];
  const token = process.env.GITHUB_TOKEN;
  if (version === undefined || token === undefined) {
    throw new Error('Usage: GITHUB_TOKEN=... bun scripts/release/upload-binaries.ts <version>');
  }
  const directory = join(import.meta.dir, '../../bin');
  const archives = selectBinaryArchives(directory);
  if (archives.length === 0) throw new Error('No binary archives found; run bun run build:binaries first');
  const targetRelease = await getOrCreateRelease(token, version);
  for (const name of archives) {
    await uploadBinaryArchive(token, targetRelease, join(directory, name), name);
    console.log(`Uploaded ${name}`);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
