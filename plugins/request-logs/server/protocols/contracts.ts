import type { RequestLogContext, RequestLogObserver, RequestLogRecords } from '@jeffusion/bungee-core/plugin';

export type JsonObject = Record<string, unknown>;
export type Result = NonNullable<Parameters<RequestLogRecords['finish']>[1]>;

export function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

export interface HttpProtocol {
  readonly operation: string;
  matches(body: JsonObject, event: string | undefined, confirmed: boolean): boolean;
  observe(body: JsonObject, event: string | undefined): Result | undefined;
  end?(): Result | undefined;
}

export interface LogProtocol {
  readonly name: string;
  http(context: RequestLogContext, streaming: boolean): HttpProtocol;
  websocket(context: RequestLogContext): RequestLogObserver | undefined;
}
