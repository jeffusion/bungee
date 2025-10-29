import type { Migration } from '../migration.types';

/**
 * Initial database schema with all features
 *
 * This migration creates the complete database schema from scratch, including:
 * - Access logs table with all fields (basic, business, auth, body/header refs, failover tracking, request type)
 * - All necessary indexes for efficient querying
 * - Statistics snapshot table
 *
 * Note: This is the ONLY initial migration. All fields are included from the start.
 * Future schema changes should be added as new migrations (002, 003, etc.).
 */
export const migration: Migration = {
  version: '001',
  name: 'initial_schema_with_failover',

  up: (db) => {
    // Create access_logs table with complete schema
    db.run(`
      CREATE TABLE IF NOT EXISTS access_logs (
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
      )
    `);

    // Create indexes for efficient querying
    db.run('CREATE INDEX IF NOT EXISTS idx_timestamp ON access_logs(timestamp DESC)');
    db.run('CREATE INDEX IF NOT EXISTS idx_path ON access_logs(path)');
    db.run('CREATE INDEX IF NOT EXISTS idx_status ON access_logs(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_success ON access_logs(success)');
    db.run('CREATE INDEX IF NOT EXISTS idx_created_at ON access_logs(created_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_request_id ON access_logs(request_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_is_failover_attempt ON access_logs(is_failover_attempt)');
    db.run('CREATE INDEX IF NOT EXISTS idx_parent_request_id ON access_logs(parent_request_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_request_type ON access_logs(request_type)');

    // Create statistics snapshot table for aggregated metrics
    db.run(`
      CREATE TABLE IF NOT EXISTS stats_snapshot (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        total_requests INTEGER,
        success_requests INTEGER,
        failed_requests INTEGER,
        avg_response_time REAL,
        created_at INTEGER NOT NULL
      )
    `);
  },
};
