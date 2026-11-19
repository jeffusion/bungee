import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { captureProcessIdentity, probeProcessIdentity, type CapturedProcessIdentity } from '../../packages/core/src/master-runtime/process-identity';
import { initializePluginSecretsKey } from '../../packages/cli/src/config/plugin-secrets-key';
import { DaemonManager } from '../../packages/cli/src/daemon/manager';
import { waitForAuthPublication } from './auth-publication-readiness';
import { makeCanonicalTempDir } from './canonical-temp';
import { waitUntil, reservePortBlock, releasePortBlock, type PortLease } from './gateway-runtime';
import { runRecoveryInTerminal, identityRecoveryAnswers } from './recovery-terminal';

function cookieHeader(response: Response): HeadersInit {
  const session = response.headers.getSetCookie().find(cookie =>
    cookie.split(';').slice(1).some(attribute => attribute.trim().toLowerCase() === 'httponly'));
  assert.ok(session, 'Management did not issue an HttpOnly session cookie');
  return { cookie: session.split(';', 1)[0]! };
}

export async function runStorageAcceptance(binary?: string) {
  const root = makeCanonicalTempDir('bungee-storage', { daemonSafe: true });
  const entry = binary ? resolve(binary) : resolve(import.meta.dir, '../../packages/core/dist/main.js');
  const executable = binary ? [entry] : [process.execPath, entry];
  const password = randomBytes(24).toString('base64url');
  const setup = { username: 'acceptance-owner', password, passwordConfirmation: password };
  const configDb = join(root, 'bungee.db');
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    BUNGEE_CONFIG_DB_PATH: configDb,
    BUNGEE_ACCESS_DB_PATH: join(root, 'access.db'),
    BUNGEE_BODY_LOG_DIR: join(root, 'bodies'),
    BUNGEE_HEADER_LOG_DIR: join(root, 'headers'),
    BUNGEE_FILE_LOG_DIR: join(root, 'files'),
    DATA_DIR: root,
    BUNGEE_PLUGIN_SECRETS_KEY: randomBytes(32).toString('base64'),
    BUNGEE_INCLUDE_SYSTEM_PLUGINS: 'false',
    PLUGINS_DIR: resolve(import.meta.dir, '../../packages/core/dist/plugins'),
    HOST: '127.0.0.1',
    BUNGEE_MANAGEMENT_HOST: '127.0.0.1',
    WORKER_COUNT: '1',
  };
  const identities = new Map<string, CapturedProcessIdentity>();
  let lease: PortLease | undefined;
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let child: ChildProcess | undefined;
  let started = false;
  let phase = 'initialization';
  let failure: unknown;

  const manager = new DaemonManager((program, args, options) => {
    child = spawn(program, args, { ...options, env: { ...options.env, PLUGINS_DIR: env.PLUGINS_DIR } });
    return child;
  }, undefined, {
    runtimeDirectory: join(root, '.bungee', 'run'),
    dataDirectory: root,
    logsDirectory: root,
    configDirectory: root,
    pidFile: join(root, 'daemon.pid'),
    logFile: join(root, 'daemon.log'),
    errorLogFile: join(root, 'daemon-error.log'),
    launchDescriptor: { executable: executable[0]!, entrypoint: binary ? null : entry },
    inheritedEnvironment: env,
  });
  const childExited = () => child !== undefined && (child.exitCode !== null || child.signalCode !== null);
  const start = async () => {
    started = true;
    await manager.start({ workers: '1' });
  };
  const stop = async () => {
    await manager.stop();
    started = false;
    if (child) {
      await waitUntil(childExited, 'Master exit was not observed', 5_000);
      assert.equal(child.exitCode, 0, 'Master did not exit gracefully');
    }
  };

  try {
    upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async request => Response.json({ message: 'storage-acceptance', payload: await request.json() }),
    });
    lease = await reservePortBlock();
    const [proxyPort, managementPort, controlPort, supervisionPort] = lease.block.ports;
    Object.assign(env, {
      PORT: String(proxyPort),
      BUNGEE_MANAGEMENT_PORT: String(managementPort),
      BUNGEE_MASTER_CONTROL_PORT: String(controlPort),
      BUNGEE_INGRESS_SUPERVISION_PORT: String(supervisionPort),
    });
    await initializePluginSecretsKey(configDb, env.BUNGEE_PLUGIN_SECRETS_KEY);
    const init = Bun.spawn([...executable, '--initialize-config', configDb], {
      cwd: root, env, stdout: Bun.file(join(root, 'init.log')), stderr: Bun.file(join(root, 'init-error.log')),
    });
    assert.equal(await boundedExit(init, 20_000), 0, 'Storage initialization failed');

    const base = `http://127.0.0.1:${managementPort}`;
    const api = (path: string, headers: HeadersInit = {}) => fetch(base + path, { headers });
    const mutate = (path: string, body: object, headers: HeadersInit = {}, method = 'POST') =>
      fetch(base + path, {
        method, headers: { origin: base, 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const wait = async (headers: HeadersInit = {}, revision?: number) => {
      const runtime = await waitForAuthPublication({
        base, headers, revision, timeoutMs: 45_000,
        childExited,
        childDiagnostic: () => ({ root, exit: child?.exitCode }),
      });
      for (const worker of runtime.workers) {
        if (!identities.has(worker.worker_instance_id)) {
          identities.set(worker.worker_instance_id, await captureProcessIdentity(worker.pid, worker.worker_instance_id));
        }
      }
    };
    const login = async (username: string, password: string, transport: 'cookie' | 'bearer') => {
      const response = await mutate('/api/auth/login', { username, password, transport }, { 'x-bungee-auth-provider': 'user-auth' });
      assert.equal(response.status, 200, `${transport} login failed`);
      const session = await response.json();
      assert.equal(session.success, true);
      return { response, session };
    };
    const assertCookieSession = async (headers: HeadersInit) => {
      const response = await api('/api/auth/verify', headers);
      assert.equal(response.status, 200);
      const session = await response.json();
      assert.equal(session.success, true);
      assert.equal(session.subject.provider, 'user-auth');
      assert.equal((await api('/api/config', headers)).status, 200);
      assert.equal(typeof session.csrfToken, 'string');
      return session.csrfToken as string;
    };

    await start();
    await waitUntil(async () => {
      if (childExited()) throw new Error('master exited before setup readiness');
      const response = await api('/api/plugins/user-auth/management-setup');
      return response.ok && (await response.json()).initialized === false;
    }, 'management setup did not become ready', 45_000);
    await wait();
    assert.equal((await (await api('/api/auth/mode')).json()).mode, 'anonymous');

    phase = 'setup';
    const enabled = await mutate('/api/plugins/user-auth/enable', {
      mutation_id: crypto.randomUUID(), managementSetup: { operation: 'initialize', ...setup },
    });
    assert.equal(enabled.status, 202, 'Management enable failed');
    const accepted = await enabled.json();
    assert.ok(Number.isSafeInteger(accepted.revision) && accepted.revision > 0);
    assert.equal(typeof accepted.operation_id, 'string');
    let revision: number = accepted.revision;
    assert.equal((await api('/api/config')).status, 401);

    phase = 'cookie-login';
    const cookie = cookieHeader((await login(setup.username, password, 'cookie')).response);
    await assertCookieSession(cookie);
    const { session } = await login(setup.username, password, 'bearer');
    assert.equal(typeof session.token, 'string');
    const bearer = { authorization: 'Bearer ' + session.token };
    await wait(bearer, revision);

    phase = 'proxy-publication';
    const snapshot = await (await api('/api/config', bearer)).json();
    assert.equal(snapshot.revision, revision);
    const serviceId = crypto.randomUUID();
    const aggregate = { ...snapshot.config, logical_configuration: { ...snapshot.config.logical_configuration,
      services: [{ id: serviceId, position: 1, name: 'acceptance', plugins: [], endpoints: [{
        id: crypto.randomUUID(), position: 1, target: `http://127.0.0.1:${upstream.port}`,
        weight: 100, priority: 1, is_disabled: false, plugins: [],
      }] }],
      routes: [{ id: crypto.randomUUID(), position: 1, path: '/acceptance', plugins: [], service_references: [{
        id: crypto.randomUUID(), position: 0, service_id: serviceId, weight: 100, priority: 1, is_disabled: false,
      }] }],
    } };
    const saved = await mutate('/api/config', { expected_revision: revision, mutation_id: crypto.randomUUID(), aggregate }, bearer, 'PUT');
    assert.equal(saved.status, 202, 'Proxy route commit failed');
    const routeAccepted = await saved.json();
    assert.ok(Number.isSafeInteger(routeAccepted.revision) && routeAccepted.revision > revision);
    revision = routeAccepted.revision;
    await wait(bearer, revision);

    const payload = { marker: crypto.randomUUID(), nested: { value: 123 } };
    const assertProxyResponse = async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/acceptance`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { message: 'storage-acceptance', payload });
    };
    await assertProxyResponse();
    const health = await (await api('/health')).json();
    assert.ok(health.live && health.management && health.data);

    phase = 'restart';
    await stop();
    await start();
    await wait(bearer, revision);
    const csrf = await assertCookieSession(cookie);
    await assertProxyResponse();

    phase = 'password-revocation';
    const changedPassword = randomBytes(24).toString('base64url');
    const changed = await mutate('/api/plugins/user-auth/control/password', {
      currentPassword: password, password: changedPassword, passwordConfirmation: changedPassword,
    }, { ...cookie, 'x-csrf-token': csrf });
    assert.equal(changed.status, 200, 'Password change failed');
    assert.equal((await api('/api/auth/verify', bearer)).status, 401);
    assert.equal((await api('/api/auth/verify', cookie)).status, 401);
    const changedCookie = cookieHeader((await login(setup.username, changedPassword, 'cookie')).response);
    const changedCsrf = await assertCookieSession(changedCookie);

    phase = 'logout';
    assert.equal((await mutate('/api/auth/logout', {}, changedCookie)).status, 403);
    await assertCookieSession(changedCookie);
    assert.equal((await mutate('/api/auth/logout', {}, { ...changedCookie, 'x-csrf-token': changedCsrf })).status, 200);
    assert.equal((await api('/api/config', changedCookie)).status, 401);
    await stop();

    phase = 'offline-recovery';
    const recoveredPassword = randomBytes(24).toString('base64url');
    const recovery = await runRecoveryInTerminal(
      [...executable, '--recover', configDb, '--plugin', 'user-auth', '--action', 'reset'],
      { cwd: root, env },
      identityRecoveryAnswers('recovered-owner', recoveredPassword, 'Storage acceptance'),
    );
    assert.equal(recovery.code, 0, 'Offline account recovery failed');
    assert.ok(!recovery.output.includes(recoveredPassword), 'Offline recovery leaked a password');
    await start();
    await waitUntil(async () => {
      try { return (await api('/api/auth/mode')).ok; }
      catch { return false; }
    }, 'restored instance unavailable', 45_000);
    const recoveredCookie = cookieHeader((await login('recovered-owner', recoveredPassword, 'cookie')).response);
    await assertCookieSession(recoveredCookie);
    await wait(recoveredCookie, revision);
    await assertProxyResponse();
  } catch (error) {
    failure = error;
    console.error(`Storage acceptance failed during ${phase}. Private fixture retained at ${root}`);
  } finally {
    const cleanupErrors: unknown[] = [];
    try { if (started) await stop(); } catch (error) { cleanupErrors.push(error); }
    for (const identity of identities.values()) {
      try {
        const state = await probeProcessIdentity(identity);
        assert.ok(state === 'dead' || state === 'mismatch', 'Worker exit not proven');
      } catch (error) { cleanupErrors.push(error); }
    }
    try { await upstream?.stop(true); } catch (error) { cleanupErrors.push(error); }
    if (lease) {
      try { await releasePortBlock(lease); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw new AggregateError(
      failure === undefined ? cleanupErrors : [failure, ...cleanupErrors], 'Storage acceptance cleanup was not proven',
    );
    if (failure === undefined) await rm(root, { recursive: true, force: true });
  }
  if (failure !== undefined) throw failure;
}

async function boundedExit(child: ReturnType<typeof Bun.spawn>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = Symbol('timeout');
  try {
    const result = await Promise.race([child.exited, new Promise<typeof timeout>(resolve => { timer = setTimeout(() => resolve(timeout), timeoutMs); })]);
    if (result !== timeout) return result;
    child.kill('SIGKILL');
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([child.exited, new Promise<never>((_, reject) => { killTimer = setTimeout(() => reject(new Error('Owned process did not exit after SIGKILL')), 10_000); })]);
    } finally { clearTimeout(killTimer); }
    throw new Error('Owned process exit timed out; forced exit confirmed');
  } finally { clearTimeout(timer); }
}
