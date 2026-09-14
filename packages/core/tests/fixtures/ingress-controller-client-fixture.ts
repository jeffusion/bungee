import { IngressControllerClient } from '../../src/ingress';
import { importSupervisionCredential } from '../../src/supervision';

const baseUrl = process.env.BUNGEE_CONTROLLER_BASE_URL;
const serializedCredential = process.env.BUNGEE_CONTROLLER_CREDENTIAL;
const authorityValue = process.env.BUNGEE_CONTROLLER_AUTHORITY;
if (baseUrl === undefined || serializedCredential === undefined || authorityValue === undefined) {
  throw new Error('controller client fixture configuration is incomplete');
}
const authority = JSON.parse(authorityValue) as { readonly controller_epoch: number; readonly controller_id: string };
const credential = importSupervisionCredential(serializedCredential);
const client = new IngressControllerClient({ baseUrl, credential });
if (process.env.BUNGEE_CONTROLLER_MODE === 'shutdown') {
  const shutdown = await client.command(authority, 5, '/shutdown', null);
  process.stdout.write(`${JSON.stringify({ shutdown })}\n`);
  process.exit(0);
}
const challenge = await client.challenge(authority);
const attached = await client.attach(challenge, authority, 1);
const frozenStatus = await client.status(authority);
const leaseExpiresAt = Date.now() + Number(process.env.BUNGEE_CONTROLLER_LEASE_MS ?? '5000');
const leased = await client.lease(authority, leaseExpiresAt, 2);
const attachedStatus = await client.status(authority);
let result: unknown = { attached, frozenStatus, leased, attachedStatus };
const admission = process.env.BUNGEE_CONTROLLER_ADMISSION;
if (admission !== undefined) {
  const set = JSON.parse(admission);
  const prepared = await client.command(authority, 3, '/prepare', set);
  const committed = await client.command(authority, 4, '/commit', set);
  result = { ...result as Record<string, unknown>, prepared, committed };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
