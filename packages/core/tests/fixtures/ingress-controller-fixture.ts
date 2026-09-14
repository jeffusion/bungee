import { resolve } from 'node:path';

const ingressEntry = resolve(import.meta.dir, '../../src/main.ts');
const workerEntry = resolve(import.meta.dir, 'ingress-transport-worker.ts');
const descriptorPath = process.env.BUNGEE_INGRESS_DESCRIPTOR_PATH;
if (descriptorPath === undefined) throw new Error('descriptor path is required');
const { BUNGEE_PLUGIN_SECRETS_KEY: _rootKey, ...inheritedEnvironment } = process.env;
const childEnvironment = { ...inheritedEnvironment };
const workerPorts = [
  ['old-0', process.env.BUNGEE_FIXTURE_OLD_PORT_0],
  ['old-1', process.env.BUNGEE_FIXTURE_OLD_PORT_1],
  ['new-0', process.env.BUNGEE_FIXTURE_NEW_PORT_0],
  ['new-1', process.env.BUNGEE_FIXTURE_NEW_PORT_1],
] as const;
const transportSecret = process.env.BUNGEE_FIXTURE_TRANSPORT_SECRET;
if (transportSecret === undefined || workerPorts.some(([, port]) => port === undefined)) {
  throw new Error('worker fixture configuration is incomplete');
}

const workers = workerPorts.map(([label, port]) => {
  const child = Bun.spawn([process.execPath, workerEntry], {
    cwd: resolve(import.meta.dir, '../..'),
    env: { ...childEnvironment, BUNGEE_FIXTURE_LABEL: label, BUNGEE_FIXTURE_PORT: port, BUNGEE_FIXTURE_TRANSPORT_SECRET: transportSecret },
    detached: true,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  child.unref();
  return { label, pid: child.pid, port: Number(port) };
});
const ingress = Bun.spawn([process.execPath, ingressEntry], {
  cwd: resolve(import.meta.dir, '../..'),
  env: { ...childEnvironment, BUNGEE_ROLE: 'ingress' },
  detached: true,
  stdout: 'ignore',
  stderr: 'ignore',
});
ingress.unref();
const detachedChildren = [ingress, ...workers.map(({ pid }) => pid)];
process.once('SIGTERM', () => {
  for (const child of detachedChildren) {
    try {
      if (typeof child === 'number') process.kill(child, process.platform === 'win32' ? undefined : 'SIGTERM');
      else child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
    } catch { /* child already exited */ }
  }
  process.exit(0);
});
const descriptor = {
  ingress: {
    pid: ingress.pid,
    public_port: Number(process.env.BUNGEE_INGRESS_PUBLIC_PORT),
    supervision_port: Number(process.env.BUNGEE_INGRESS_SUPERVISION_PORT),
  },
  workers,
};
await Bun.write(descriptorPath, JSON.stringify(descriptor));
process.stdout.write(`${JSON.stringify(descriptor)}\n`);
setInterval(() => undefined, 60_000);
