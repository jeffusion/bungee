import { runMain } from '../../src/main';
import { CORE_HOST_VERSION } from '../../src/core-version';

// Keep provider transport controlled while exercising the production entry and lifecycle.
const upstream = process.env.BUNGEE_TEST_UPDATE_ORIGIN;
if (process.argv[2] !== '--version' && (!upstream || new URL(upstream).hostname !== '127.0.0.1')) throw new Error('Missing owned update fixture server');
const request = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url === 'https://api.github.com/repos/jeffusion/bungee/releases/latest') return request(`${upstream}/latest`, init);
  if (/^https:\/\/github\.com\/jeffusion\/bungee\/releases\/download\/v6\.6\.1\/bungee-[a-z0-9.-]+\.tar\.gz$/.test(url)) return request(`${upstream}/archive`, init);
  return request(input, init);
}) as typeof fetch;
if (process.argv[2] !== '--version' && process.env.BUNGEE_TEST_FAIL_VERSION === CORE_HOST_VERSION) process.env.BUNGEE_MANAGEMENT_PORT = 'invalid';
await runMain();
