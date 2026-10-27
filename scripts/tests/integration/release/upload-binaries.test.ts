import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectBinaryArchives, uploadBinaryArchive } from '../../../release/upload-binaries';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bungee-upload-assets-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('selectBinaryArchives', () => {
  test('selects release archives and excludes bare binaries', () => {
    // Given
    writeFileSync(join(root, 'bungee-linux'), 'bare');
    writeFileSync(join(root, 'bungee-linux.tar.gz'), 'archive');
    writeFileSync(join(root, 'bungee-macos.tar.gz'), 'archive');

    // When
    const selected = selectBinaryArchives(root);

    // Then
    expect(selected).toEqual(['bungee-linux.tar.gz', 'bungee-macos.tar.gz']);
  });
});

describe('uploadBinaryArchive', () => {
  const name = 'bungee-linux.tar.gz';
  const targetRelease = { id: 1, upload_url: 'https://uploads.github.com/repos/jeffusion/bungee/releases/1/assets{?name,label}' };
  const listing = 'https://api.github.com/repos/jeffusion/bungee/releases/1/assets?per_page=100&page=1';
  const uploadUrl = `https://uploads.github.com/repos/jeffusion/bungee/releases/1/assets?name=${name}`;
  const deletion = 'https://api.github.com/repos/jeffusion/bungee/releases/assets/7';
  const saved = { id: 7, name, state: 'uploaded', size: 7, digest: 'sha256:0eb3e36bfb24dcd9bb1d1bece1531216b59539a8fde17ee80224af0653c92aa3' };
  const starter = { ...saved, state: 'starter', size: 0, digest: null };
  let steps: { method: string; url: string; response: Response | Error }[];
  let requestIndex: number;
  let fetchMock: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
  let sleepMock: ReturnType<typeof spyOn<typeof Bun, 'sleep'>>;

  beforeEach(() => {
    writeFileSync(join(root, name), 'archive');
    steps = [];
    requestIndex = 0;
    sleepMock = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
      const step = steps[requestIndex++];
      expect(step).toBeDefined();
      expect(String(input)).toBe(step!.url);
      expect(options?.method ?? 'GET').toBe(step!.method);
      const headers = new Headers(options?.headers);
      expect(headers.get('authorization')).toBe('Bearer test-token');
      if (step!.method === 'POST') {
        expect(headers.get('content-type')).toBe('application/gzip');
        expect(headers.get('content-length')).toBe('7');
        expect(await new Response(options?.body).text()).toBe('archive');
      }
      if (step!.response instanceof Error) throw step!.response;
      return step!.response;
    }, { preconnect: fetch.preconnect }));
  });
  afterEach(() => {
    fetchMock.mockRestore();
    sleepMock.mockRestore();
    expect(requestIndex).toBe(steps.length);
  });

  test('uploads a missing archive', async () => {
    steps = [
      { method: 'GET', url: listing, response: Response.json([]) },
      { method: 'POST', url: uploadUrl, response: Response.json(saved, { status: 201 }) },
    ];
    await uploadBinaryArchive('test-token', targetRelease, join(root, name), name);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  test('preserves an existing archive with matching size and digest', async () => {
    steps = [{ method: 'GET', url: listing, response: Response.json([saved]) }];
    await uploadBinaryArchive('test-token', targetRelease, join(root, name), name);
  });

  test.each([
    new Error('connection reset'),
    new DOMException('request timed out', 'TimeoutError'),
    Response.json({ message: 'Error updating policy' }, { status: 502 }),
    Response.json({ message: 'already_exists' }, { status: 422 }),
  ])('recovers a saved archive after an unsuccessful upload response %#', async (response) => {
    steps = [
      { method: 'GET', url: listing, response: Response.json([]) },
      { method: 'POST', url: uploadUrl, response },
      { method: 'GET', url: listing, response: Response.json([saved]) },
    ];
    await uploadBinaryArchive('test-token', targetRelease, join(root, name), name);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  test.each([
    { ...saved, size: 8 },
    { ...saved, digest: `sha256:${'0'.repeat(64)}` },
    { ...saved, digest: null },
    { ...saved, state: 'starter' },
  ])('refuses to delete or replace a conflicting archive %#', async (asset) => {
    steps = [{ method: 'GET', url: listing, response: Response.json([asset]) }];
    await expect(uploadBinaryArchive('test-token', targetRelease, join(root, name), name)).rejects.toThrow('refusing to replace');
  });

  test('cleans an empty starter before the first upload', async () => {
    steps = [
      { method: 'GET', url: listing, response: Response.json([starter]) },
      { method: 'DELETE', url: deletion, response: new Response(null, { status: 204 }) },
      { method: 'POST', url: uploadUrl, response: Response.json(saved, { status: 201 }) },
    ];
    await uploadBinaryArchive('test-token', targetRelease, join(root, name), name);
  });

  test('cleans an empty starter after a server failure and retries', async () => {
    steps = [
      { method: 'GET', url: listing, response: Response.json([]) },
      { method: 'POST', url: uploadUrl, response: Response.json({ message: 'upstream failure' }, { status: 502 }) },
      { method: 'GET', url: listing, response: Response.json([starter]) },
      { method: 'DELETE', url: deletion, response: new Response(null, { status: 204 }) },
      { method: 'POST', url: uploadUrl, response: Response.json(saved, { status: 201 }) },
    ];
    await uploadBinaryArchive('test-token', targetRelease, join(root, name), name);
    expect(sleepMock.mock.calls).toEqual([[1000]]);
  });

  test('retries a network failure when no archive was saved', async () => {
    steps = [
      { method: 'GET', url: listing, response: Response.json([]) },
      { method: 'POST', url: uploadUrl, response: new Error('connection reset') },
      { method: 'GET', url: listing, response: Response.json([]) },
      { method: 'POST', url: uploadUrl, response: Response.json(saved, { status: 201 }) },
    ];
    await uploadBinaryArchive('test-token', targetRelease, join(root, name), name);
    expect(sleepMock.mock.calls).toEqual([[1000]]);
  });

  test.each([400, 401, 403, 422])('does not retry HTTP %i when no archive was saved', async (status) => {
    steps = [
      { method: 'GET', url: listing, response: Response.json([]) },
      { method: 'POST', url: uploadUrl, response: Response.json({ message: 'rejected' }, { status, headers: { 'x-github-request-id': 'request-1' } }) },
      { method: 'GET', url: listing, response: Response.json([]) },
    ];
    await expect(uploadBinaryArchive('test-token', targetRelease, join(root, name), name)).rejects.toThrow(`HTTP ${status}, request request-1`);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  test('stops after three failed attempts and retains the final HTTP error', async () => {
    steps = [{ method: 'GET', url: listing, response: Response.json([]) }];
    for (let attempt = 1; attempt <= 3; attempt++) steps.push(
      { method: 'POST', url: uploadUrl, response: Response.json({ message: 'unavailable' }, { status: 503, headers: { 'x-github-request-id': `request-${attempt}` } }) },
      { method: 'GET', url: listing, response: Response.json([]) },
    );
    await expect(uploadBinaryArchive('test-token', targetRelease, join(root, name), name)).rejects.toThrow('HTTP 503, request request-3');
    expect(sleepMock.mock.calls).toEqual([[1000], [2000]]);
  });

  test('fails without another upload when verification is unavailable', async () => {
    steps = [
      { method: 'GET', url: listing, response: Response.json([]) },
      { method: 'POST', url: uploadUrl, response: Response.json({ message: 'upload failed' }, { status: 502 }) },
      { method: 'GET', url: listing, response: Response.json({ message: 'listing failed' }, { status: 503 }) },
    ];
    await expect(uploadBinaryArchive('test-token', targetRelease, join(root, name), name)).rejects.toThrow(/HTTP 502.*upload verification failed:.*HTTP 503/);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  test('stops if deleting an empty starter fails', async () => {
    steps = [
      { method: 'GET', url: listing, response: Response.json([starter]) },
      { method: 'DELETE', url: deletion, response: Response.json({ message: 'forbidden' }, { status: 403 }) },
    ];
    await expect(uploadBinaryArchive('test-token', targetRelease, join(root, name), name)).rejects.toThrow('Failed to delete empty starter');
  });

  test('checks later asset pages before uploading', async () => {
    steps = [
      { method: 'GET', url: listing, response: Response.json(Array.from({ length: 100 }, (_, index) => ({ ...saved, id: index + 10, name: `other-${index}` }))) },
      { method: 'GET', url: listing.replace('&page=1', '&page=2'), response: Response.json([saved]) },
    ];
    await uploadBinaryArchive('test-token', targetRelease, join(root, name), name);
  });

  test('rejects malformed metadata before uploading', async () => {
    steps = [{ method: 'GET', url: listing, response: Response.json([{ ...saved, digest: 'invalid' }]) }];
    await expect(uploadBinaryArchive('test-token', targetRelease, join(root, name), name)).rejects.toThrow('invalid asset');
  });
});
