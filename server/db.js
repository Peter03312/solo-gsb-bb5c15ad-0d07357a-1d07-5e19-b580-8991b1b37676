'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

/**
 * 打开（并按需初始化）SQLite 数据库。
 * 幂等：表/索引已存在时不会重建，数据得以保留。
 * 同时可作为迁移脚本独立运行：npm run migrate
 */
function openDb() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadDir(), { recursive: true });

  const db = new Database(config.dbFile());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      image_file   TEXT    NOT NULL,
      image_mime   TEXT    NOT NULL,
      width        INTEGER NOT NULL,
      height       INTEGER NOT NULL,
      version      INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS regions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id      INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      code         TEXT    NOT NULL,
      risk_level   TEXT    NOT NULL,
      vertices     TEXT    NOT NULL,   -- JSON: [{"x":..,"y":..}, ...]，原图坐标
      version      INTEGER NOT NULL DEFAULT 1,
      deleted      INTEGER NOT NULL DEFAULT 0,  -- 软删除墓碑，用于版本/冲突语义
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 同一图上「未删除」区域编号唯一；编号删除后允许复用
    CREATE UNIQUE INDEX IF NOT EXISTS idx_regions_code_active
      ON regions(plan_id, code) WHERE deleted = 0;

    CREATE INDEX IF NOT EXISTS idx_regions_plan
      ON regions(plan_id, deleted);
  `);

  return db;
}

// 直接执行 `node server/db.js` 时完成初始化并退出（供依赖初始化/CI 使用）
if (require.main === module) {
  const db = openDb();
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'"
  ).all();
  console.log('数据库初始化完成:', config.dbFile());
  console.log('对象:', tables.map((t) => t.name).join(', '));
  db.close();
}

module.exports = { openDb };
