import { DEFAULT_MANAGEMENT_PORT } from './management';

export type ConfigIoOptions = {
  readonly host?: string;
  readonly port?: string;
  readonly file: string;
  readonly token?: string;
};

type ImportAcknowledgement = {
  readonly operation_id: string;
  readonly revision: number;
};

function endpoint(options: ConfigIoOptions, path: string): string {
  const host = options.host ?? 'localhost';
  const port = options.port ?? DEFAULT_MANAGEMENT_PORT;
  return `http://${host}:${port}/api/config${path === '' ? '' : `/${path}`}`;
}

async function writeFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

function headers(token: string | undefined): Record<string, string> {
  return {
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  };
}

function acknowledgement(value: unknown): ImportAcknowledgement | null {
  if (typeof value !== 'object' || value === null) return null;
  const { operation_id, revision } = value as Record<string, unknown>;
  if (typeof operation_id !== 'string' || operation_id.length === 0 ||
      typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= 0) return null;
  return { operation_id, revision };
}

function currentRevision(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const revision = (value as Record<string, unknown>).revision;
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

function unknownOutcome(mutationId: string, cause?: unknown): Error {
  return new Error(
    `Import result is unknown; check whether the configuration was saved before retrying. Reference ${mutationId}`,
    { cause },
  );
}

function reportedResultUnknown(body: string): boolean {
  try {
    const value = JSON.parse(body) as { error?: unknown };
    return value.error === 'result_unknown';
  } catch {
    return false;
  }
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
  let envelope: unknown;
  try {
    envelope = JSON.parse(snapshot);
  } catch (cause) {
    throw new Error(`Import failed: ${options.file} is not valid JSON`, { cause });
  }

  const currentResponse = await fetch(endpoint(options, ''), {
    headers: headers(options.token),
  });
  if (!currentResponse.ok) {
    const body = await currentResponse.text();
    throw new Error(`Import failed: cannot read current revision: ${currentResponse.status} ${body}`);
  }
  let current: unknown;
  try {
    current = await currentResponse.json();
  } catch (cause) {
    throw new Error('Import failed: current revision response is invalid', { cause });
  }
  const expectedRevision = currentRevision(current);
  if (expectedRevision === null) {
    throw new Error('Import failed: current revision response is invalid');
  }

  const mutationId = crypto.randomUUID();
  const response = await fetch(endpoint(options, 'import'), {
    method: 'POST',
    headers: { ...headers(options.token), 'content-type': 'application/json' },
    body: JSON.stringify({ expected_revision: expectedRevision, mutation_id: mutationId, envelope }),
  }).catch((cause: unknown) => {
    throw unknownOutcome(mutationId, cause);
  });
  if (!response.ok) {
    let body: string;
    try { body = await response.text(); }
    catch (cause) { throw unknownOutcome(mutationId, cause); }
    if (reportedResultUnknown(body)) throw unknownOutcome(mutationId);
    throw new Error(`Import failed: ${response.status} ${body}`);
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch (cause) {
    throw unknownOutcome(mutationId, cause);
  }
  const accepted = acknowledgement(value);
  if (accepted === null || accepted.operation_id !== mutationId) {
    throw unknownOutcome(mutationId);
  }
  console.log(`Config saved from ${options.file}`);
}
