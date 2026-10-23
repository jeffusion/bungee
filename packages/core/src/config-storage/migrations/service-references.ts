import type { ConfigMigration } from './plan';

/** A relation has one concrete owner and a stable target Service identity. */
export const SERVICE_REFERENCES_MIGRATION: ConfigMigration = {
  version: 5,
  name: 'service_references',
  up(db) {
    db.run(`CREATE TABLE service_references (
      id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'),
      owner_kind TEXT NOT NULL CHECK(owner_kind IN ('service','route')),
      owner_service_id TEXT REFERENCES services(id) ON DELETE CASCADE,
      route_id TEXT REFERENCES routes(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 9007199254740991),
      service_id TEXT NOT NULL REFERENCES services(id),
      weight REAL NOT NULL CHECK(weight>0),
      priority REAL NOT NULL CHECK(priority>0),
      is_disabled INTEGER NOT NULL CHECK(is_disabled IN (0,1)),
      CHECK((owner_kind='service' AND owner_service_id IS NOT NULL AND route_id IS NULL AND owner_service_id<>service_id)
        OR (owner_kind='route' AND route_id IS NOT NULL AND owner_service_id IS NULL)),
      UNIQUE(owner_service_id,position), UNIQUE(route_id,position),
      UNIQUE(owner_service_id,service_id), UNIQUE(route_id,service_id)
    ) STRICT`);
    db.run(`INSERT INTO service_references(id,owner_kind,owner_service_id,route_id,position,service_id,weight,priority,is_disabled)
      SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2)
        || '-8' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
        'route',NULL,id,0,service_id,100,1,0 FROM routes WHERE service_id IS NOT NULL`);
    db.run('ALTER TABLE routes DROP COLUMN service_id');
  },
};
