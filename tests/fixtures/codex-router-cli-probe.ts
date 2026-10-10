/** Optional real CLI probe. Every auth/config/cache path belongs to this fixture. */
import {spawn} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {captureProcessIdentity, probeProcessIdentity, type CapturedProcessIdentity} from '../../packages/core/src/master-runtime/process-identity';
import {assertCodexProbeTargets} from './codex-router-gateway-fixture';

export const CLI_TOOL_ROUNDTRIP = 'codex-fixture-real-tool-roundtrip';
export const CLI_EXEC_MARKER = 'codex-fixture-exec-marker';
export const CLI_MCP_MARKER = 'codex-fixture-mcp-marker';
export const CLI_PATCH_MARKER = 'codex-fixture-patch-marker';

// A real stdio MCP child started by Codex, not an emulated app-server tool result.
export const echoMcpScript = String.raw`import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const auditPath = process.argv[2];
const audit = (event) => appendFileSync(auditPath, JSON.stringify({pid: process.pid, ...event}) + '\n');
audit({event: 'started'});
const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc: '2.0', id, result}) + '\n');
let stopped = false;
const stop = () => {if (!stopped) {stopped = true; audit({event: 'stopped'});} process.exit(0);};
process.on('SIGTERM', stop);
const lines = createInterface({input: process.stdin});
lines.on('close', stop);
lines.on('line', line => {
  let message; try {message = JSON.parse(line);} catch {return;}
  if (message.id === undefined) return;
  if (message.method === 'initialize') return reply(message.id, {protocolVersion: message.params.protocolVersion,
    capabilities: {tools: {listChanged: false}}, serverInfo: {name: 'codex-fixture-echo', version: '1.0.0'}});
  if (message.method === 'ping') return reply(message.id, {});
  if (message.method === 'tools/list') return reply(message.id, {tools: [{name: 'echo', description: 'codex_fixture_echo_tool: side-effect-free local echo',
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    inputSchema: {type: 'object', properties: {fixture_echo: {type: 'string'}}, required: ['fixture_echo'], additionalProperties: false}}]});
  if (message.method === 'tools/call' && message.params.name === 'echo') {
    const text = String(message.params.arguments.fixture_echo); audit({event: 'tools/call', name: 'echo', text});
    return reply(message.id, {content: [{type: 'text', text}], isError: false});
  }
  process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: message.id, error: {code: -32601, message: 'fixture method not found'}}) + '\n');
});`;

function isolatedEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {HOME: home, CODEX_HOME: home, USERPROFILE: home, TMPDIR: home};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

/** A valid native catalog row from exactly the installed CLI, without reading auth. */
export async function bundledCodexCatalogModel(root: string): Promise<Record<string, any>> {
  assertCodexProbeTargets(root);
  const executable = Bun.which('codex'); if (!executable) throw new Error('local codex executable is missing');
  const home = join(root, 'cli-bundled-home'); await mkdir(home, {recursive: true});
  const child = spawn(executable, ['debug', 'models', '--bundled'], {cwd: home, env: isolatedEnv(home), stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout?.on('data', data => {stdout += String(data);}); child.stderr?.on('data', data => {stderr += String(data);});
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {child.kill('SIGKILL'); reject(new Error('bundled models probe timed out'));}, 10000);
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('close', code => {clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`bundled models probe failed: ${stderr.slice(-2000)}`));});
  });
  const catalog = JSON.parse(stdout);
  const model = catalog.models.find((model: any) => model.visibility === 'list');
  if (!model) throw new Error('installed CLI contains no visible native catalog row');
  return {...model, slug: 'native-only', display_name: 'Native fixture model', extra: {keep: true}};
}

export async function probeCodexCli(input: {root: string; baseUrl: string; token: string; model: string}) {
  assertCodexProbeTargets(input.root,[input.baseUrl]);
  const executable = Bun.which('codex');
  if (!executable) throw new Error('BUNGEE_CODEX_CLI_PROBE requires a local codex executable');
  const home = join(input.root, 'cli-home'); await mkdir(home, {recursive: true});
  // This is only a freshly issued local-fixture credential, never user OpenAI auth.
  await writeFile(join(home, 'auth.json'), JSON.stringify({OPENAI_API_KEY: input.token}), {mode: 0o600});
  const env = isolatedEnv(home);
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json',
    '-C', home, '-m', input.model, '-c', 'model_provider="bungee-fixture"', '-c', 'model_reasoning_effort="low"',
    '-c', `model_providers.bungee-fixture={name="Bungee local fixture",base_url=${JSON.stringify(input.baseUrl)},wire_api="responses",requires_openai_auth=true,request_max_retries=0,stream_max_retries=0,stream_idle_timeout_ms=10000}`,
    'Reply with fixture answer. Do not call tools or inspect files.'];
  const child = spawn(executable, args, {cwd: home, env, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '', timedOut = false;
  child.stdout?.on('data', data => {stdout = (stdout + String(data)).slice(-32768);});
  child.stderr?.on('data', data => {stderr = (stderr + String(data)).slice(-32768);});
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {timedOut = true; child.kill('SIGKILL');}, 20000);
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('close', value => {clearTimeout(timer); resolve(value);});
  });
  const redact = (value: string) => value.split(input.token).join('[local-fixture-token]');
  return {pid: child.pid, code, timedOut, stdout: redact(stdout), stderr: redact(stderr), model: input.model,
    authSource: 'fresh local fixture credential in isolated CODEX_HOME/auth.json'};
}

/** CLI model/list with temporary ChatGPT-shaped auth and real local key-access. */
export async function probeCodexChatgptModels(input: {root: string; baseUrl: string; mockUrl: string; token: string; model: string; toolRoundTrip?: boolean; effort?: string}) {
  assertCodexProbeTargets(input.root,[input.baseUrl,input.mockUrl]);
  const executable = Bun.which('codex');
  if (!executable) throw new Error('BUNGEE_CODEX_CLI_PROBE requires a local codex executable');
  const home = join(input.root, input.toolRoundTrip ? `cli-chatgpt-tool-${input.model.replaceAll('/','-')}` : input.model === 'org/chat' ? 'cli-chatgpt-chat-home'
    : input.model === 'org/anthropic' ? 'cli-chatgpt-anthropic-home' : 'cli-chatgpt-home'); await mkdir(home, {recursive: true});
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = {email: 'fixture@example.invalid', exp: Math.floor(Date.now() / 1000) + 86400,
    'https://api.openai.com/auth': {chatgpt_plan_type: 'pro', chatgpt_account_id: 'fixture-account', chatgpt_user_id: 'fixture-user'}};
  const idToken = `${encode({alg: 'none', typ: 'JWT'})}.${encode(claims)}.c3R1Yg`;
  await writeFile(join(home, 'auth.json'), JSON.stringify({auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: {id_token: idToken, access_token: input.token, refresh_token: 'fixture-unused-refresh', account_id: 'fixture-account'},
    last_refresh: new Date().toISOString()}), {mode: 0o600});
  const mcpAuditPath = join(home, 'mcp-audit.jsonl'), mcpInstanceId = randomUUID();
  let mcpIdentity: CapturedProcessIdentity | undefined;
  const readMcpAudit = async (): Promise<any[]> => (await readFile(mcpAuditPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  let mcpConfig = '';
  if (input.toolRoundTrip) {
    const scriptPath = join(home, 'echo-mcp.mjs'); await writeFile(scriptPath, echoMcpScript);
    mcpConfig = `\n[mcp_servers.codex_fixture]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([scriptPath, mcpAuditPath, `--bungee-process-identity=${mcpInstanceId}`])}\nstartup_timeout_sec = 5\ntool_timeout_sec = 5\n`;
  }
  await writeFile(join(home, 'config.toml'), `model_provider = "openai"\nweb_search = "disabled"\nopenai_base_url = ${JSON.stringify(input.baseUrl)}\nchatgpt_base_url = ${JSON.stringify(`${input.mockUrl}/backend-api`)}\ncli_auth_credentials_store = "file"\n[analytics]\nenabled = false\n${mcpConfig}`);
  const child = spawn(executable, ['app-server', '--stdio'], {cwd: home, env: isolatedEnv(home), stdio: ['pipe', 'pipe', 'pipe']});
  let buffer = '', stderr = '', exitCode: number | null = null, exited = false;
  const messages: any[] = [], waiters = new Map<number, {resolve(value: any): void; reject(error: Error): void}>();
  const closed = new Promise<void>(resolve => child.once('close', code => {exitCode = code; exited = true; resolve();}));
  child.stdout?.on('data', data => {
    buffer += String(data);
    for (;;) {
      const newline = buffer.indexOf('\n'); if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let value: any; try {value = JSON.parse(line);} catch {continue;}
      messages.push(value); if (messages.length > 512) messages.shift();
      if (typeof value.id === 'number') {waiters.get(value.id)?.resolve(value); waiters.delete(value.id);}
    }
  });
  child.stderr?.on('data', data => {stderr = (stderr + String(data)).slice(-32768);});
  child.once('error', error => {for (const waiter of waiters.values()) waiter.reject(error); waiters.clear();});
  child.once('close', () => {for (const waiter of waiters.values()) waiter.reject(new Error('isolated app-server exited')); waiters.clear();});
  const send = (value: unknown) => child.stdin!.write(`${JSON.stringify(value)}\n`);
  const rpc = (id: number, method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {waiters.delete(id); reject(new Error(`isolated app-server ${method} timed out: ${stderr.split(input.token).join('[local-fixture-token]')}`));}, 15000);
    waiters.set(id, {resolve(value) {clearTimeout(timer); resolve(value);}, reject(error) {clearTimeout(timer); reject(error);}});
    send({id, method, params});
  });
  let report: any;
  try {
    const initialize = await rpc(1, 'initialize', {clientInfo: {name: 'bungee_fixture_catalog', version: '1.0'}, capabilities: {experimentalApi: true}});
    if (initialize.error) throw new Error(`app-server initialize failed: ${JSON.stringify(initialize.error)}`);
    send({method: 'initialized'});
    const account = await rpc(2, 'account/read', {refreshToken: false});
    const catalog = await rpc(3, 'model/list', {includeHidden: false});
    const listedModels = (catalog.result?.data ?? []).map((model: any) => model.model);
    const thread = await rpc(4, 'thread/start', {model: input.model, cwd: home, approvalPolicy: 'never', sandbox: input.toolRoundTrip ? 'workspace-write' : 'read-only', experimentalRawEvents: false});
    if (thread.error || !thread.result?.thread?.id) throw new Error(`app-server thread failed: ${JSON.stringify(thread.error)}`);
    if (input.toolRoundTrip) {
      const deadline = Date.now() + 5000;
      let started: any;
      while (!(started = (await readMcpAudit()).find(event => event.event === 'started')) && Date.now() < deadline && !exited) await Bun.sleep(25);
      if (started) mcpIdentity = await captureProcessIdentity(started.pid, mcpInstanceId);
    }
    const prompt = input.toolRoundTrip
      ? `${CLI_TOOL_ROUNDTRIP}: follow the fixture model's three tool calls, then finish. Only run its printf marker command, apply its patch to fixture-patched.txt in this temporary working directory, and call the local MCP echo. Do not inspect or modify other files.`
      : 'Reply with fixture answer. Do not call tools or inspect files.';
    const turn = await rpc(5, 'turn/start', {threadId: thread.result.thread.id, input: [{type: 'text', text: prompt}], ...(input.effort ? {effort: input.effort} : {})});
    if (turn.error) throw new Error(`app-server turn failed: ${JSON.stringify(turn.error)}`);
    const deadline = Date.now() + 15000;
    while (!messages.some(message => message.method === 'turn/completed') && Date.now() < deadline && !exited) await Bun.sleep(25);
    if (!messages.some(message => message.method === 'turn/completed')) throw new Error('app-server model dispatch did not complete');
    report = {pid: child.pid, accountType: account.result?.account?.type, accountError: account.error ?? null,
      listedModels, reasoningModels: (catalog.result?.data ?? []).filter((model: any) => model.model === input.model)
        .map((model: any) => ({model:model.model,levels:model.supportedReasoningEfforts?.map((entry: any)=>entry.reasoningEffort),defaultEffort:model.defaultReasoningEffort})),
      modelListError: catalog.error ?? null, selectedModel: input.model, selectedEffort: input.effort ?? null,
      notifications: messages.filter(message => ['turn/completed', 'error', 'item/started', 'item/completed'].includes(message.method)).map(message => {
        const item = message.params?.item;
        return {method: message.method, status: message.params?.turn?.status ?? item?.status, itemType: item?.type, itemId: item?.id,
          text: item?.text, command: item?.command, output: item?.aggregatedOutput, exitCode: item?.exitCode,
          server: item?.server, tool: item?.tool, changeCount: item?.changes?.length, error: message.params?.error?.message};
      }),
      authSource: 'isolated stub id_token claims and fresh local key-access token'};
  } finally {
    if (!exited) child.kill('SIGTERM');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closed, new Promise<void>(resolve => {timeout = setTimeout(resolve, 5000);})]);
    if (timeout) clearTimeout(timeout);
    if (!exited) {child.kill('SIGKILL'); await closed;}
    if (input.toolRoundTrip) {
      const started = (await readMcpAudit()).find(event => event.event === 'started');
      if (!mcpIdentity && started) try {mcpIdentity = await captureProcessIdentity(started.pid, mcpInstanceId);} catch { /* A naturally stopped MCP child cannot be captured. */ }
      if (mcpIdentity) {
        // Never signal an unverified/reused PID; normal app-server shutdown closes stdio.
        let state = await probeProcessIdentity(mcpIdentity);
        if (state === 'exact') try {process.kill(mcpIdentity.pid, 'SIGTERM');} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}
        const deadline = Date.now() + 2000;
        while ((state = await probeProcessIdentity(mcpIdentity)) === 'exact' && Date.now() < deadline) await Bun.sleep(25);
        if (state === 'exact') {try {process.kill(mcpIdentity.pid, 'SIGKILL');} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}
          const killDeadline = Date.now() + 2000;
          while ((state = await probeProcessIdentity(mcpIdentity)) === 'exact' && Date.now() < killDeadline) await Bun.sleep(25);
        }
        if (!['dead', 'mismatch'].includes(state)) throw new Error(`owned MCP child shutdown not verified: ${state}`);
        if (report) report.mcpShutdown = state;
      }
    }
  }
  return {...report, ...(input.toolRoundTrip ? {mcpAudit: await readMcpAudit(),patchedContent:await readFile(join(home,'fixture-patched.txt'),'utf8').catch(()=>null)} : {}), exitCode,
    stderr: stderr.split(input.token).join('[local-fixture-token]').split(idToken).join('[stub-id-token]')};
}
