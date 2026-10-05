/**
 * server/db.js — SQLite 数据访问层
 *
 * 并发模型：
 *   - regions.version 从 1 开始，每次更新 +1；更新/删除必须带期望版本（乐观锁）
 *   - 删除为软删除（deleted=1），唯一编号随之释放，但旧版本提交无法“复活”记录
 *   - 所有多语句写操作在 immediate 事务中执行，better-sqlite3 串行化保证隔离
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 1;

export function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS maps (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      width      INTEGER NOT NULL CHECK (width > 0),
      height     INTEGER NOT NULL CHECK (height > 0),
      mime_type  TEXT NOT NULL,
      image      BLOB NOT NULL,
      version    INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS regions (
      id         TEXT PRIMARY KEY,
      map_id     TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      code       TEXT NOT NULL,
      risk       TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
      points     TEXT NOT NULL,
      version    INTEGER NOT NULL DEFAULT 1,
      deleted    INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 唯一编号在「同一图、未删除」范围内唯一；删除后编号可复用
    CREATE UNIQUE INDEX IF NOT EXISTS ux_regions_code_alive
      ON regions(map_id, code) WHERE deleted = 0;

    CREATE INDEX IF NOT EXISTS ix_regions_map ON regions(map_id) WHERE deleted = 0;

    CREATE TABLE IF NOT EXISTS events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      map_id    TEXT NOT NULL,
      type      TEXT NOT NULL,
      payload   TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO meta(key, value) VALUES('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(SCHEMA_VERSION));
}

export const now = () => Date.now();

export function createMap(db, { name, width, height, mimeType, image }) {
  const id = randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO maps(id, name, width, height, mime_type, image, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(id, name, width, height, mimeType, image, ts, ts);
  return getMapMeta(db, id);
}

export function getMapMeta(db, id) {
  return db
    .prepare(`SELECT id, name, width, height, mime_type, version, created_at, updated_at FROM maps WHERE id = ?`)
    .get(id);
}

export function getMapImage(db, id) {
  return db.prepare(`SELECT image, mime_type FROM maps WHERE id = ?`).get(id);
}

export function listMaps(db) {
  return db
    .prepare(
      `SELECT id, name, width, height, version, created_at, updated_at,
              (SELECT COUNT(*) FROM regions r WHERE r.map_id = maps.id AND r.deleted = 0) AS region_count
       FROM maps ORDER BY created_at DESC`
    )
    .all();
}

export function listRegions(db, mapId) {
  return db
    .prepare(
      `SELECT id, map_id, code, risk, points, version, created_at, updated_at
       FROM regions WHERE map_id = ? AND deleted = 0 ORDER BY created_at ASC`
    )
    .all(mapId)
    .map(rowToRegion);
}

export function getRegionForUpdate(db, mapId, regionId) {
  return db
    .prepare(`SELECT * FROM regions WHERE id = ? AND map_id = ?`)
    .get(regionId, mapId);
}

export function findAliveRegionByCode(db, mapId, code, excludeId = null) {
  return db
    .prepare(
      `SELECT id FROM regions WHERE map_id = ? AND code = ? AND deleted = 0
       ${excludeId ? 'AND id != ?' : ''}`
    )
    .get(...(excludeId ? [mapId, code, excludeId] : [mapId, code]));
}

export function insertRegion(db, { mapId, code, risk, points }) {
  const id = randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO regions(id, map_id, code, risk, points, version, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`
  ).run(id, mapId, code, risk, JSON.stringify(points), ts, ts);
  bumpMapVersion(db, mapId, ts);
  appendEvent(db, mapId, 'region_created', { id, code });
  return rowToRegion(db.prepare(`SELECT * FROM regions WHERE id = ?`).get(id));
}

export function updateRegion(db, region, { code, risk, points }) {
  const ts = now();
  const nextVersion = region.version + 1;
  db.prepare(
    `UPDATE regions SET code = ?, risk = ?, points = ?, version = ?, updated_at = ? WHERE id = ?`
  ).run(code, risk, JSON.stringify(points), nextVersion, ts, region.id);
  bumpMapVersion(db, mapIdOf(region), ts);
  appendEvent(db, mapIdOf(region), 'region_updated', { id: region.id, code, version: nextVersion });
  return rowToRegion(db.prepare(`SELECT * FROM regions WHERE id = ?`).get(region.id));
}

export function softDeleteRegion(db, region) {
  const ts = now();
  const nextVersion = region.version + 1;
  db.prepare(
    `UPDATE regions SET deleted = 1, version = ?, updated_at = ? WHERE id = ?`
  ).run(nextVersion, ts, region.id);
  bumpMapVersion(db, mapIdOf(region), ts);
  appendEvent(db, mapIdOf(region), 'region_deleted', { id: region.id, code: region.code, version: nextVersion });
}

/**
 * 按快照替换「文档中包含的」图（按 ID 对齐）；库中其它图保持不变。
 * 全部在单个事务中完成；任何一步抛错都会 ROLLBACK，
 * 数据库保持导入前状态（不会出现部分写入）。
 * @param snapshots [{meta, image, regions}]
 */
export function replaceMapsWithSnapshots(db, snapshots) {
  const tx = db.transaction((items) => {
    const delMap = db.prepare(`DELETE FROM maps WHERE id = ?`);
    const delEvents = db.prepare(`DELETE FROM events WHERE map_id = ?`);
    const insMap = db.prepare(
      `INSERT INTO maps(id, name, width, height, mime_type, image, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insRegion = db.prepare(
      `INSERT INTO regions(id, map_id, code, risk, points, version, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
    );

    for (const s of items) {
      const m = s.meta;
      delEvents.run(m.id);
      delMap.run(m.id);
      insMap.run(m.id, m.name, m.width, m.height, m.mime_type, s.image, m.version, m.created_at, m.updated_at);
      for (const r of s.regions) {
        insRegion.run(
          r.id, m.id, r.code, r.risk, JSON.stringify(r.points), r.version,
          r.created_at ?? r.createdAt, r.updated_at ?? r.updatedAt
        );
      }
    }
  });
  tx.immediate(snapshots);
}

export function exportSnapshot(db, mapId) {
  const meta = getMapMeta(db, mapId);
  if (!meta) return null;
  const img = getMapImage(db, mapId);
  return {
    meta,
    imageBase64: img.image.toString('base64'),
    regions: listRegions(db, mapId),
  };
}

export function listEventsSince(db, mapId, afterId) {
  return db
    .prepare(`SELECT id, type, payload, created_at FROM events WHERE map_id = ? AND id > ? ORDER BY id ASC LIMIT 1000`)
    .all(mapId, afterId);
}

export function latestEventId(db) {
  const row = db.prepare(`SELECT MAX(id) AS id FROM events`).get();
  return row.id ?? 0;
}

function bumpMapVersion(db, mapId, ts) {
  db.prepare(`UPDATE maps SET version = version + 1, updated_at = ? WHERE id = ?`).run(ts, mapId);
}

function appendEvent(db, mapId, type, payload) {
  db.prepare(`INSERT INTO events(map_id, type, payload, created_at) VALUES (?, ?, ?, ?)`)
    .run(mapId, type, JSON.stringify(payload), now());
}

function mapIdOf(region) {
  return region.map_id;
}

export function rowToRegion(row) {
  return {
    id: row.id,
    mapId: row.map_id,
    code: row.code,
    risk: row.risk,
    points: JSON.parse(row.points),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
