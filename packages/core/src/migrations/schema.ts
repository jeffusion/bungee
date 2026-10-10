/** Current schema baseline. Future changes use incremental migrations. */
export const ACCESS_SCHEMA_STATEMENTS = [
  `CREATE TABLE access_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT UNIQUE NOT NULL,
        timestamp INTEGER NOT NULL,

        -- Request basic information
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        query TEXT,
        status INTEGER NOT NULL,
        duration INTEGER NOT NULL,

        -- Business information
        route_path TEXT,
        upstream TEXT,
        transformer TEXT,
        transformed_path TEXT,

        -- Processing steps (JSON)
        processing_steps TEXT,

        -- Authentication information
        auth_success INTEGER DEFAULT 1,
        auth_level TEXT,

        -- Error information
        error_message TEXT,

        -- Body reference IDs (stored in separate files)
        req_body_id TEXT,
        resp_body_id TEXT,

        -- Header reference IDs (stored in separate files)
        req_header_id TEXT,
        resp_header_id TEXT,

        -- Original request references (before transformation)
        original_req_header_id TEXT,
        original_req_body_id TEXT,

        -- Failover tracking fields
        is_failover_attempt INTEGER DEFAULT 0,
        parent_request_id TEXT,
        attempt_number INTEGER,
        attempt_upstream TEXT,

        -- Request type classification (mutually exclusive)
        request_type TEXT DEFAULT 'final',

        -- Index fields
        success INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      , protocol_outcome TEXT, protocol_code TEXT, transport_outcome TEXT, transport_code TEXT)`,
  `CREATE TABLE plugin_registry (
        name TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        description TEXT,
        path TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
  `CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL)`,
  `CREATE TABLE stats_snapshot (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        total_requests INTEGER,
        success_requests INTEGER,
        failed_requests INTEGER,
        avg_response_time REAL,
        created_at INTEGER NOT NULL
      )`,
  `CREATE TABLE "token_stats_attempts" (
        attempt_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        finished_at_ms INTEGER NOT NULL CHECK (finished_at_ms >= 0),
        route_id TEXT NOT NULL,
        upstream_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        outcome TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
        output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
        input_source TEXT NOT NULL CHECK (input_source IN ('usage', 'estimated', 'partial', 'unknown')),
        output_source TEXT NOT NULL CHECK (output_source IN ('usage', 'estimated', 'partial', 'unknown')),
        cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
        cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
        cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
        observation_incomplete INTEGER NOT NULL CHECK (observation_incomplete IN (0, 1)), key_id TEXT,
        CHECK ((input_source = 'unknown') = (input_tokens IS NULL)),
        CHECK ((output_source = 'unknown') = (output_tokens IS NULL))
      )`,
  `CREATE INDEX idx_created_at ON access_logs(created_at)`,
  `CREATE INDEX idx_is_failover_attempt ON access_logs(is_failover_attempt)`,
  `CREATE INDEX idx_parent_request_id ON access_logs(parent_request_id)`,
  `CREATE INDEX idx_path ON access_logs(path)`,
  `CREATE INDEX idx_plugin_registry_enabled
      ON plugin_registry(enabled)
    `,
  `CREATE INDEX idx_protocol_outcome ON access_logs(protocol_outcome)`,
  `CREATE INDEX idx_request_id ON access_logs(request_id)`,
  `CREATE INDEX idx_request_type ON access_logs(request_type)`,
  `CREATE INDEX idx_status ON access_logs(status)`,
  `CREATE INDEX idx_success ON access_logs(success)`,
  `CREATE INDEX idx_timestamp ON access_logs(timestamp DESC)`,
  `CREATE INDEX idx_token_stats_attempts_finished ON token_stats_attempts(finished_at_ms)`,
  `CREATE INDEX idx_token_stats_attempts_key_finished ON token_stats_attempts(key_id, finished_at_ms)`,
  `CREATE INDEX idx_transport_outcome ON access_logs(transport_outcome)`
] as const;
