import type { Database } from 'bun:sqlite';

type CachedEditorModelCatalogPayload = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

type MemoryCacheEntry = {
  expiresAt: number;
  payload: CachedEditorModelCatalogPayload;
};

const CACHE_NAMESPACE = '__editor-model-catalog__';
const DEFAULT_CACHE_TTL_SECONDS = 10 * 60;

export class EditorModelCatalogCache {
  private memoryCache = new Map<string, MemoryCacheEntry>();
  private inFlight = new Map<string, Promise<Response>>();

  constructor(private readonly db: Database) {}

  async getOrLoad(
    cacheKey: string,
    loader: () => Promise<Response>,
    ttlSeconds: number = DEFAULT_CACHE_TTL_SECONDS,
  ): Promise<Response> {
    const memoryHit = this.memoryCache.get(cacheKey);
    if (memoryHit && memoryHit.expiresAt > Date.now()) {
      return this.clonePayload(memoryHit.payload);
    }

    const persistedFresh = this.readPersisted(cacheKey, false);
    if (persistedFresh) {
      this.memoryCache.set(cacheKey, persistedFresh);
      return this.clonePayload(persistedFresh.payload);
    }

    const running = this.inFlight.get(cacheKey);
    if (running) {
      return await running;
    }

    const request = (async () => {
      try {
        const response = await loader();
        if (!response.ok) {
          return response;
        }

        const payload = await this.toPayload(response);
        const expiresAt = Date.now() + ttlSeconds * 1000;
        this.memoryCache.set(cacheKey, { expiresAt, payload });
        this.writePersisted(cacheKey, payload, ttlSeconds);
        return this.clonePayload(payload);
      } catch (error) {
        const persistedStale = this.readPersisted(cacheKey, true);
        if (persistedStale) {
          this.memoryCache.set(cacheKey, {
            expiresAt: Date.now() + 60 * 1000,
            payload: persistedStale.payload,
          });
          return this.clonePayload(persistedStale.payload);
        }
        throw error;
      } finally {
        this.inFlight.delete(cacheKey);
      }
    })();

    this.inFlight.set(cacheKey, request);
    return await request;
  }

  resetForTests(): void {
    this.memoryCache.clear();
    this.inFlight.clear();
    this.db.prepare('DELETE FROM plugin_storage WHERE plugin_name = ?').run(CACHE_NAMESPACE);
  }

  private readPersisted(cacheKey: string, allowExpired: boolean): MemoryCacheEntry | null {
    const row = this.db.prepare(`
      SELECT value, ttl
      FROM plugin_storage
      WHERE plugin_name = ? AND key = ?
    `).get(CACHE_NAMESPACE, cacheKey) as { value: string; ttl: number | null } | null;

    if (!row) {
      return null;
    }

    const expiresAt = typeof row.ttl === 'number' ? row.ttl * 1000 : 0;
    if (!allowExpired && expiresAt > 0 && expiresAt < Date.now()) {
      return null;
    }

    return {
      expiresAt,
      payload: JSON.parse(row.value) as CachedEditorModelCatalogPayload,
    };
  }

  private writePersisted(cacheKey: string, payload: CachedEditorModelCatalogPayload, ttlSeconds: number): void {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + ttlSeconds;
    this.db.prepare(`
      INSERT OR REPLACE INTO plugin_storage (plugin_name, key, value, ttl, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(CACHE_NAMESPACE, cacheKey, JSON.stringify(payload), expiresAtSeconds, Date.now());
  }

  private async toPayload(response: Response): Promise<CachedEditorModelCatalogPayload> {
    const body = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      status: response.status,
      headers,
      body,
    };
  }

  private clonePayload(payload: CachedEditorModelCatalogPayload): Response {
    return new Response(payload.body, {
      status: payload.status,
      headers: payload.headers,
    });
  }
}

export function buildEditorModelCatalogCacheKey(pluginName: string, pluginVersion: string | undefined, identity: string): string {
  return ['v1', pluginName, pluginVersion || 'unknown', identity].join(':');
}

export function getDefaultEditorModelCatalogIdentity(req: Request): string {
  const url = new URL(req.url);
  return `${url.pathname}?${url.searchParams.toString()}`;
}

export const DEFAULT_EDITOR_MODEL_CATALOG_TTL_SECONDS = DEFAULT_CACHE_TTL_SECONDS;
