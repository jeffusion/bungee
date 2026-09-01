#!/usr/bin/env bun

import { existsSync, readdirSync, statSync } from 'node:fs';
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
    if (!object(item) || typeof item.id !== 'number' || typeof item.name !== 'string') {
      throw new Error('GitHub returned an invalid asset');
    }
    return { id: item.id, name: item.name };
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
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function getOrCreateRelease(token: string, version: string): Promise<Release> {
  const tag = `v${version}`;
  const existing = await fetch(`${API}/repos/${REPOSITORY}/releases/tags/${tag}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000),
  });
  if (existing.ok) return release(await existing.json());
  if (existing.status !== 404) throw new Error(`GitHub API ${existing.status}: ${await existing.text()}`);
  return release(await github(token, `/repos/${REPOSITORY}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: tag, body: `Release ${tag}`, draft: false, prerelease: false }),
  }));
}

async function deleteExistingAsset(token: string, releaseId: number, name: string): Promise<void> {
  const existing = assets(await github(token, `/repos/${REPOSITORY}/releases/${releaseId}/assets`))
    .find((asset) => asset.name === name);
  if (existing === undefined) return;
  const response = await fetch(`${API}/repos/${REPOSITORY}/releases/assets/${existing.id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Failed to delete ${name}: HTTP ${response.status}`);
}

async function upload(token: string, uploadUrl: string, filePath: string, name: string): Promise<void> {
  const size = statSync(filePath).size;
  const response = await fetch(uploadUrl.replace('{?name,label}', `?name=${encodeURIComponent(name)}`), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/gzip',
      'Content-Length': String(size),
    },
    body: Bun.file(filePath),
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) throw new Error(`Failed to upload ${name}: ${await response.text()}`);
}

async function main(): Promise<void> {
  const version = process.argv[2];
  const token = process.env.GITHUB_TOKEN;
  if (version === undefined || token === undefined) {
    throw new Error('Usage: GITHUB_TOKEN=... bun scripts/upload-binaries.ts <version>');
  }
  const directory = join(import.meta.dir, '../bin');
  const archives = selectBinaryArchives(directory);
  if (archives.length === 0) throw new Error('No binary archives found; run bun run build:binaries first');
  const targetRelease = await getOrCreateRelease(token, version);
  for (const name of archives) {
    await deleteExistingAsset(token, targetRelease.id, name);
    await upload(token, targetRelease.upload_url, join(directory, name), name);
    console.log(`Uploaded ${name}`);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
