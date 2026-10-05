/**
 * server/index.js — HTTP 服务入口
 *
 * 仅依赖 Node 内置模块 + better-sqlite3 + busboy，无第三方账号、无外部服务。
 * 环境变量：
 *   PORT       监听端口，默认 8080
 *   HOST       监听地址，默认 0.0.0.0
 *   DB_PATH    SQLite 文件路径，默认 ./data/floorplan.db
 *   MAX_UPLOAD_MB 单张图片/导入 JSON 大小上限，默认 100
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import busboy from 'busboy';

import { openDb, createMap, getMapMeta, getMapImage, listMaps, listRegions,
  getRegionForUpdate, insertRegion, updateRegion,
  softDeleteRegion, replaceMapsWithSnapshots, exportSnapshot, listEventsSince,
  latestEventId } from './db.js';
import { readImageInfo, ImageError } from './image.js';
import { checkNewRegion, checkUpdateRegion, validateExportDocument,
  sanitizeCode } from './validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'floorplan.db');
const MAX_BYTES = parseInt(process.env.MAX_UPLOAD_MB || '100', 10) * 1024 * 1024;

mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = openDb(DB_PATH);

/* ---------------- SSE 事件推送 ---------------- */

const sseClients = new Map(); // mapId -> Set<res>

function publish(mapId, event) {
  const set = sseClients.get(mapId);
  if (!set) return;
  const frame = `event: change\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    try {
      res.write(frame);
    } catch {
      set.delete(res);
    }
  }
}

/* ---------------- HTTP 工具 ---------------- */

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
  });
  res.end(buf);
}

function sendError(res, status, reason, detail) {
  sendJson(res, status, { error: reason, detail: detail || reason });
}

function readJsonBody(req, limit = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体超过大小限制'), { statusCode: 413, reason: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('JSON 解析失败'), { statusCode: 400, reason: 'invalid_json' }));
      }
    });
    req.on('error', reject);
  });
}

const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/shared/geometry.js': { file: path.join('..', 'shared', 'geometry.js'), type: 'application/javascript; charset=utf-8' },
};

async function serveStatic(res, urlPath) {
  const entry = STATIC_FILES[urlPath];
  if (!entry) return sendError(res, 404, 'not_found', '资源不存在');
  try {
    const buf = await readFile(path.join(PUBLIC_DIR, entry.file));
    res.writeHead(200, {
      'content-type': entry.type,
      'content-length': buf.length,
      'cache-control': 'no-cache',
    });
    res.end(buf);
  } catch {
    sendError(res, 404, 'not_found', '资源不存在');
  }
}

/* ---------------- 业务处理器 ---------------- */

function handleListMaps(res) {
  sendJson(res, 200, { maps: listMaps(db) });
}

function handleUpload(req, res) {
  const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_BYTES, files: 1, fields: 4 } });
  let fileBuf = null;
  let fileMime = '';
  let declaredName = '';
  let tooBig = false;
  let settled = false;

  bb.on('file', (name, stream, info) => {
    fileMime = info.mimeType;
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        tooBig = true;
      }
      chunks.push(c);
    });
    stream.on('limit', () => { tooBig = true; });
    stream.on('end', () => {
      if (!tooBig) fileBuf = Buffer.concat(chunks);
    });
  });
  bb.on('field', (name, val) => {
    if (name === 'name') declaredName = val;
  });
  bb.on('error', () => {
    if (!settled) {
      settled = true;
      sendError(res, 400, 'invalid_upload', 'multipart 表单解析失败');
    }
  });
  bb.on('close', () => {
    if (settled) return;
    settled = true;
    if (tooBig) return sendError(res, 413, 'payload_too_large', `图片超过 ${process.env.MAX_UPLOAD_MB || 100}MB 上限`);
    if (!fileBuf) return sendError(res, 400, 'missing_image', '未收到图片文件（字段名需为 image，PNG/JPEG）');

    let info;
    try {
      info = readImageInfo(fileBuf, fileMime);
    } catch (err) {
      const status = err instanceof ImageError ? 400 : 500;
      return sendError(res, status, 'invalid_image', err.message);
    }

    const baseName = declaredName.trim() || '未命名展馆图';
    if (baseName.length > 128) return sendError(res, 400, 'invalid_name', '名称不能超过 128 字符');

    try {
      const meta = createMap(db, {
        name: baseName,
        width: info.width,
        height: info.height,
        mimeType: info.mimeType,
        image: fileBuf,
      });
      sendJson(res, 201, { map: publicMap(meta, []) });
    } catch (err) {
      sendError(res, 500, 'create_failed', err.message);
    }
  });
  req.pipe(bb);
}

function requireMap(mapId) {
  const meta = getMapMeta(db, mapId);
  if (!meta) return null;
  const regions = listRegions(db, mapId);
  return { meta, regions };
}

function handleGetMap(res, mapId) {
  const m = requireMap(mapId);
  if (!m) return sendError(res, 404, 'map_not_found', '图不存在或已删除');
  sendJson(res, 200, { map: publicMap(m.meta, m.regions) });
}

function handleGetImage(req, res, mapId) {
  const row = getMapImage(db, mapId);
  if (!row) return sendError(res, 404, 'map_not_found', '图不存在');
  const etag = `"${mapId}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    return res.end();
  }
  res.writeHead(200, {
    'content-type': row.mime_type,
    'cache-control': 'private, max-age=31536000, immutable',
    etag,
  });
  res.end(row.image);
}

function handleDeleteMap(res, mapId) {
  const meta = getMapMeta(db, mapId);
  if (!meta) return sendError(res, 404, 'map_not_found', '图不存在');
  db.prepare(`DELETE FROM maps WHERE id = ?`).run(mapId);
  publish(mapId, { type: 'map_deleted', at: Date.now() });
  sendJson(res, 200, { ok: true });
}

function handleCreateRegion(res, mapId, body) {
  const m = requireMap(mapId);
  if (!m) return sendError(res, 404, 'map_not_found', '图不存在');

  const code = sanitizeCode(body?.code);
  const risk = body?.risk;
  const result = checkNewRegion({
    code, risk, points: body?.points,
    width: m.meta.width, height: m.meta.height,
    others: m.regions,
  });
  if (!result.ok) return sendError(res, result.status, result.reason, result.detail);

  try {
    const region = db.transaction(() => {
      // 事务内重读，挡住建连期间的并发写入
      const fresh = listRegions(db, mapId);
      const recheck = checkNewRegion({
        code, risk, points: body.points,
        width: m.meta.width, height: m.meta.height, others: fresh,
      });
      if (!recheck.ok) {
        throw httpError(recheck.status, recheck.reason, recheck.detail);
      }
      return insertRegion(db, { mapId, code, risk, points: recheck.points });
    }).immediate();

    const evt = lastChange(mapId);
    publish(mapId, evt);
    sendJson(res, 201, { region, mapVersion: getMapMeta(db, mapId).version });
  } catch (err) {
    if (err.httpStatus) return sendError(res, err.httpStatus, err.reason, err.detail);
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      return sendError(res, 409, 'duplicate_code', `编号「${code}」刚被其它用户占用，请刷新后重试`);
    }
    sendError(res, 500, 'create_failed', err.message);
  }
}

function handleUpdateRegion(res, mapId, regionId, body) {
  const expectedVersion = parseInt(body?.expectedVersion, 10);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return sendError(res, 400, 'missing_version', '必须提交 expectedVersion（区域当前版本号）');
  }

  try {
    const result = db.transaction(() => {
      const region = getRegionForUpdate(db, mapId, regionId);
      if (!region || region.deleted === 1) {
        // 区域从未存在或已删除：旧提交一律不能恢复它
        throw httpError(409, 'version_conflict',
          '该区域已被删除（或不存在），基于旧版本的提交无法恢复区域');
      }
      if (region.version !== expectedVersion) {
        throw httpError(409, 'version_conflict',
          `版本冲突：你的版本是 v${expectedVersion}，当前已是 v${region.version}（可能有他人刚修改过）。` +
          '你的编辑已保留在画布上，请刷新区域信息后重新提交');
      }

      const code = sanitizeCode(body.code);
      const risk = body.risk;
      const others = listRegions(db, mapId);
      const check = checkUpdateRegion({
        code, risk, points: body.points,
        width: getMapMeta(db, mapId).width,
        height: getMapMeta(db, mapId).height,
        others, region,
      });
      if (!check.ok) throw httpError(check.status, check.reason, check.detail);

      return updateRegion(db, region, { code, risk, points: check.points });
    }).immediate();

    publish(mapId, lastChange(mapId));
    sendJson(res, 200, { region: result, mapVersion: getMapMeta(db, mapId).version });
  } catch (err) {
    if (err.httpStatus) return sendError(res, err.httpStatus, err.reason, err.detail);
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      return sendError(res, 409, 'duplicate_code', '编号刚被其它用户占用，请刷新后重试');
    }
    sendError(res, 500, 'update_failed', err.message);
  }
}

function handleDeleteRegion(res, mapId, regionId, expectedVersion) {
  const version = parseInt(expectedVersion, 10);
  if (!Number.isInteger(version) || version < 1) {
    return sendError(res, 400, 'missing_version', '删除必须带 expectedVersion');
  }
  try {
    db.transaction(() => {
      const region = getRegionForUpdate(db, mapId, regionId);
      if (!region) throw httpError(404, 'region_not_found', '区域不存在');
      if (region.deleted === 1) {
        // 已删除是幂等终点：旧版本提交不能复活
        throw httpError(409, 'version_conflict', '区域已被删除，旧版本提交无效');
      }
      if (region.version !== version) {
        throw httpError(409, 'version_conflict',
          `版本冲突：该区域已被他人修改到 v${region.version}，你的删除基于 v${version}。请刷新确认后再删`);
      }
      softDeleteRegion(db, region);
    }).immediate();

    publish(mapId, lastChange(mapId));
    sendJson(res, 200, { ok: true, mapVersion: getMapMeta(db, mapId).version });
  } catch (err) {
    if (err.httpStatus) return sendError(res, err.httpStatus, err.reason, err.detail);
    sendError(res, 500, 'delete_failed', err.message);
  }
}

function handleExport(res, mapId) {
  const snap = exportSnapshot(db, mapId);
  if (!snap) return sendError(res, 404, 'map_not_found', '图不存在');
  const doc = {
    format: 'floorplan-annotator/v1',
    exportedAt: Date.now(),
    maps: [{
      meta: {
        id: snap.meta.id,
        name: snap.meta.name,
        width: snap.meta.width,
        height: snap.meta.height,
        mime_type: snap.meta.mime_type,
        version: snap.meta.version,
        created_at: snap.meta.created_at,
        updated_at: snap.meta.updated_at,
      },
      imageBase64: snap.imageBase64,
      regions: snap.regions.map((r) => ({
        id: r.id, code: r.code, risk: r.risk, points: r.points,
        version: r.version, createdAt: r.createdAt, updatedAt: r.updatedAt,
      })),
    }],
  };
  const buf = Buffer.from(JSON.stringify(doc));
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="floorplan-${mapId}.json"`,
    'content-length': buf.length,
  });
  res.end(buf);
}

async function handleImport(req, res) {
  let doc;
  try {
    const body = await readJsonBody(req);
    doc = validateExportDocument(body);
  } catch (err) {
    if (err.statusCode) return sendError(res, err.statusCode, err.reason || 'bad_request', err.message);
    return sendError(res, 400, 'invalid_import', err.message);
  }

  // 再次确认图片字节与声明尺寸一致（导出文件可能被手工篡改）
  for (const m of doc.maps) {
    try {
      const info = readImageInfo(m.image, m.meta.mime_type);
      if (info.width !== m.meta.width || info.height !== m.meta.height) {
        return sendError(res, 400, 'invalid_import',
          `图「${m.meta.name}」声明尺寸 ${m.meta.width}x${m.meta.height} 与实际图片 ${info.width}x${info.height} 不一致`);
      }
      m.meta.mime_type = info.mimeType;
    } catch (err) {
      const e = err instanceof ImageError ? err : new ImageError('图片无法解析');
      return sendError(res, 400, 'invalid_import', `图「${m.meta.name}」：${e.message}`);
    }
  }

  try {
    // 按 ID 替换文档中的图（其它图不受影响）；事务失败整体回滚，无部分写入
    replaceMapsWithSnapshots(db, doc.maps);
    for (const m of doc.maps) publish(m.meta.id, { type: 'imported', at: Date.now() });
    sendJson(res, 200, {
      ok: true,
      imported: doc.maps.map((m) => ({
        id: m.meta.id, name: m.meta.name,
        width: m.meta.width, height: m.meta.height,
        version: m.meta.version, regionCount: m.regions.length,
      })),
    });
  } catch (err) {
    sendError(res, 500, 'import_failed', `导入已中止，数据库未改动：${err.message}`);
  }
}

function handleEvents(req, res, mapId, afterId) {
  if (!getMapMeta(db, mapId)) return sendError(res, 404, 'map_not_found', '图不存在');

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);

  let after = afterId;
  // 连接时先补发错过的事件
  const backlog = listEventsSince(db, mapId, after);
  for (const e of backlog) {
    res.write(`id: ${e.id}\nevent: change\ndata: ${JSON.stringify({ id: e.id, type: e.type, payload: JSON.parse(e.payload), at: e.created_at })}\n\n`);
    after = e.id;
  }
  res.write(`: ok\n\n`);

  let set = sseClients.get(mapId);
  if (!set) {
    set = new Set();
    sseClients.set(mapId, set);
  }
  set.add(res);

  const ping = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* ignore */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    set.delete(res);
  });
}

function lastChange(mapId) {
  const id = latestEventId(db);
  const rows = listEventsSince(db, mapId, id - 1);
  const e = rows[rows.length - 1];
  return e
    ? { id: e.id, type: e.type, payload: JSON.parse(e.payload), at: e.created_at }
    : { type: 'changed', at: Date.now() };
}

function httpError(status, reason, detail) {
  return Object.assign(new Error(detail), { httpStatus: status, reason, detail });
}

function publicMap(meta, regions) {
  return {
    id: meta.id,
    name: meta.name,
    width: meta.width,
    height: meta.height,
    mimeType: meta.mime_type,
    version: meta.version,
    regions: regions.map((r) => ({
      id: r.id, code: r.code, risk: r.risk,
      points: r.points, version: r.version,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    })),
  };
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && STATIC_FILES[p] !== undefined) {
      return await serveStatic(res, p);
    }

    if (p === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, db: path.basename(DB_PATH) });
    }
    if (p === '/api/maps' && req.method === 'GET') return handleListMaps(res);
    if (p === '/api/maps' && req.method === 'POST') return handleUpload(req, res);
    if (p === '/api/import' && req.method === 'POST') return handleImport(req, res);

    let mm = p.match(/^\/api\/maps\/([0-9a-f-]{36})(\/.*)?$/);
    if (mm) {
      const mapId = mm[1];
      const sub = mm[2] || '';

      if (sub === '' && req.method === 'GET') return handleGetMap(res, mapId);
      if (sub === '' && req.method === 'DELETE') return handleDeleteMap(res, mapId);
      if (sub === '/image' && req.method === 'GET') return handleGetImage(req, res, mapId);
      if (sub === '/export' && req.method === 'GET') return handleExport(res, mapId);

      if (sub === '/events' && req.method === 'GET') {
        const after = parseInt(url.searchParams.get('after') || '0', 10);
        return handleEvents(req, res, mapId, Number.isInteger(after) ? after : 0);
      }

      if (sub === '/regions' && req.method === 'POST') {
        const body = await readJsonBody(req, 2 * 1024 * 1024);
        return handleCreateRegion(res, mapId, body);
      }

      mm = sub.match(/^\/regions\/([0-9a-f-]{36})$/);
      if (mm) {
        const regionId = mm[1];
        if (req.method === 'PUT') {
          const body = await readJsonBody(req, 2 * 1024 * 1024);
          return handleUpdateRegion(res, mapId, regionId, body);
        }
        if (req.method === 'DELETE') {
          return handleDeleteRegion(res, mapId, regionId, url.searchParams.get('expectedVersion'));
        }
      }
    }

    sendError(res, 404, 'not_found', `未知接口：${req.method} ${p}`);
  } catch (err) {
    if (err.statusCode) return sendError(res, err.statusCode, err.reason || 'bad_request', err.message);
    console.error('[server]', err);
    if (!res.headersSent) sendError(res, 500, 'internal_error', '服务器内部错误');
  }
});

if (!existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
  console.warn('[warn] public/ 目录缺失，前端将无法访问');
}

server.listen(PORT, HOST, () => {
  console.log(`展馆平面图标注服务已启动`);
  console.log(`  监听:   http://${HOST}:${PORT}`);
  console.log(`  数据库: ${DB_PATH}`);
});
