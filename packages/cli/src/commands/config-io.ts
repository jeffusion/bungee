const OPERATION_TIMEOUT_MS = 15_000;
const OPERATION_POLL_INTERVAL_MS = 100;

export type ConfigIoOptions = {
  readonly host?: string;
  readonly port?: string;
  readonly file: string;
  readonly token?: string;
  readonly nextToken?: string;
};

type ConfigurationOperationState = {
  readonly operation:
    | { readonly state: 'committed' | 'publishing' | 'draining'; readonly result_status: null }
    | { readonly state: 'converged'; readonly result_status: 200 }
    | { readonly state: 'degraded'; readonly result_status: 202; readonly error_detail: string };
};

type AcceptedConfigurationOperation = ConfigurationOperationState & {
  readonly operation_id: string;
  readonly revision: number;
};

function endpoint(options: ConfigIoOptions, path: string): string {
  const host = options.host ?? 'localhost';
  const port = options.port ?? '8088';
  return `http://${host}:${port}/__ui/api/config/${path}`;
}

async function writeFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

function headers(token: string | undefined, nextToken?: string): Record<string, string> {
  return {
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    ...(nextToken === undefined ? {} : { 'x-bungee-next-authorization': `Bearer ${nextToken}` }),
  };
}

export async function exportCommand(options: ConfigIoOptions): Promise<void> {
  const response = await fetch(endpoint(options, 'export'), {
    headers: headers(options.token),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Export failed: ${response.status} ${body}`);
  }
  await writeFile(options.file, await response.text());
  console.log(`Config exported to ${options.file}`);
}

export async function importCommand(options: ConfigIoOptions): Promise<void> {
  const snapshot = await Bun.file(options.file).text();
  const response = await fetch(endpoint(options, 'import'), {
    method: 'POST',
    headers: { ...headers(options.token, options.nextToken), 'content-type': 'application/json' },
    body: snapshot,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Import failed: ${response.status} ${body}`);
  }
  const accepted = await response.json() as AcceptedConfigurationOperation;
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  let state: ConfigurationOperationState = accepted;

  while (true) {
    switch (state.operation.state) {
      case 'converged':
        console.log(`Config imported from ${options.file}: revision ${accepted.revision} operation ${accepted.operation_id}`);
        return;
      case 'degraded':
        throw new Error(`Import failed: operation ${accepted.operation_id} degraded: ${state.operation.error_detail}`);
      case 'committed':
      case 'publishing':
      case 'draining':
        break;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Import failed: operation ${accepted.operation_id} timed out after ${OPERATION_TIMEOUT_MS}ms`);
    }
    const poll = await fetch(endpoint(options, `operations/${accepted.operation_id}`), {
      headers: headers(options.nextToken ?? options.token),
      signal: AbortSignal.timeout(remainingMs),
    });
    if (!poll.ok) {
      const body = await poll.text();
      throw new Error(`Import failed: operation poll returned ${poll.status} ${body}`);
    }
    state = await poll.json() as ConfigurationOperationState;
    if (state.operation.result_status === null) {
      await Bun.sleep(Math.min(OPERATION_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
  }
}
