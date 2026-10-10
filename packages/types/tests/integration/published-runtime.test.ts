import { describe, expect, test } from 'bun:test';

describe('published types package runtime', () => {
  test('imports the built package export without source path aliases', async () => {
    const published = await import('@jeffusion/bungee-types');
    const publishedTypes = await import('@jeffusion/bungee-types/types');
    const daemonFile = await import('@jeffusion/bungee-types/daemon-file');
    expect(typeof daemonFile.readDaemonMetadataFile).toBe('function');
    const metadata = {
      schema: 'bungee-daemon-metadata-v1',
      launcher_pid: 5678,
      state: 'armed',
      boot_nonce: 'abcdef12-3456-7890-abcd-ef1234567890',
      instance_id: '00000000-0000-0000-0000-000000000002',
      pid: 1234,
      management_host: '127.0.0.1',
      management_port: 8089,
      executable: '/usr/local/bin/bungee',
      shutdown_secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      entrypoint: null,
    } as const;
    const launching = {
      ...metadata,
      state: 'launching',
      pid: null,
      instance_id: null,
      management_host: null,
      management_port: null,
    } as const;
    const encoded = published.encodeDaemonMetadataV1(metadata);
    expect(published.parseDaemonMetadataV1(encoded)).toEqual(metadata);
    expect(publishedTypes.parseDaemonMetadataV1(publishedTypes.encodeDaemonMetadataV1(metadata))).toEqual(metadata);
    expect(published.parseDaemonMetadataV1(published.encodeDaemonMetadataV1(launching))).toEqual(launching);
    expect(publishedTypes.parseDaemonMetadataV1(publishedTypes.encodeDaemonMetadataV1(launching))).toEqual(launching);

    const nodeCheck = Bun.spawn([
      'node', '--input-type=module', '-e',
      "const root = await import('@jeffusion/bungee-types'); const types = await import('@jeffusion/bungee-types/types'); const daemon = await import('@jeffusion/bungee-types/daemon-file'); const m = { schema: 'bungee-daemon-metadata-v1', launcher_pid: 5678, state: 'armed', boot_nonce: 'abcdef12-3456-7890-abcd-ef1234567890', instance_id: '00000000-0000-0000-0000-000000000002', pid: 1234, management_host: '127.0.0.1', management_port: 8089, executable: '/usr/local/bin/bungee', shutdown_secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', entrypoint: null }; if (root.parseDaemonMetadataV1(root.encodeDaemonMetadataV1(m)).pid !== 1234 || types.parseDaemonMetadataV1(types.encodeDaemonMetadataV1(m)).pid !== 1234 || typeof daemon.readDaemonMetadataFile !== 'function') process.exit(1);",
    ], { stdout: 'pipe', stderr: 'pipe' });
    expect(await nodeCheck.exited).toBe(0);
  });
});
