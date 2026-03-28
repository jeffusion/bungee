export interface MutableRequestContext {
  url: URL;
  headers: Record<string, string>;
  body: any;
  [key: string]: any;
}

export interface ResponseContext {
  response: Response;
  [key: string]: any;
}

export interface StreamChunkContext {
  streamState: Map<string, any>;
  chunkIndex?: number;
  isFirstChunk?: boolean;
  isLastChunk?: boolean;
  [key: string]: any;
}

export interface AIConverter {
  readonly from: string;
  readonly to: string;

  setRuntimeOptions?(options: unknown): void;
  onBeforeRequest?(ctx: MutableRequestContext): Promise<void>;
  onResponse?(ctx: ResponseContext): Promise<Response | void>;
  processStreamChunk?(chunk: any, ctx: StreamChunkContext): Promise<any[] | null>;
  flushStream?(ctx: StreamChunkContext): Promise<any[]>;
}

export type TransformDirection = `${string}-${string}`;
