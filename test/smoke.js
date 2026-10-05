/**
 * test/smoke.js — 端到端冒烟测试
 * 运行：node test/smoke.js（会自行拉起临时端口 + 临时数据库的服务进程）
 *
 * 覆盖：
 *  1. 健康检查 / 静态页
 *  2. 合法 PNG 上传；损坏 PNG、伪造类型被拒绝且不产生数据
 *  3. 区域创建：合法、自交、越界、重叠、重复编号
 *  4. 乐观锁：旧版本更新冲突、正确版本成功、删除后旧提交无法复活
 *  5. SSE 事件补发
 *  6. 导出/导入往返保持尺寸、区域、版本；坏 JSON / 矛盾数据整体拒绝且无部分写入
 *  7. 几何库：仅边界相接允许、包含关系拒绝、蝴蝶结自交拒绝
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';

import { validatePoints, polygonsOverlap } from '../shared/geometry.js';

const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(path.join(tmpdir(), 'floorplan-smoke-'));
const dbPath = path.join(dir, 'test.db');

let passed = 0;
let failed = 0;
function ok(cond, name, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name} ${extra}`); }
}
function eq(a, b, name) { ok(a === b, name, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`); }

/* ---------- 最小合法 PNG 构造 ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const rowLen = width * 4;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowLen + 1)] = 0;
    for (let x = 0; x < rowLen; x++) raw[y * (rowLen + 1) + 1 + x] = (x + y) % 256;
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function waitHealthy(proc, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* retry */ }
    if (proc.exitCode !== null) throw new Error('server exited early: ' + proc.log);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server not healthy');
}

function sseOnce(after = 0, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}/api/maps/${mapId}/events?after=${after}`, (res) => {
      if (res.statusCode !== 200) return reject(new Error('SSE status ' + res.statusCode));
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        if (buf.includes('event: change')) { req.destroy(); resolve(buf); }
      });
    });
    req.on('error', (e) => e.code === 'ECONNRESET' ? resolve('replayed') : reject(e));
    setTimeout(() => { req.destroy(); resolve(buf_or_nothing()); }, timeoutMs);
    function buf_or_nothing() { return null; }
  });
}

/* ---------- 几何单元 ---------- */
function unitGeometry() {
  console.log('\n[几何单元]');
  const W = 100, H = 100;

  const bowtie = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 100 }];
  ok(!validatePoints(bowtie, W, H).ok, '蝴蝶结四边形判定为自交');

  const oob = [{ x: -1, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 120 }];
  const r1 = validatePoints(oob, W, H);
  eq(r1.ok, false, '越界顶点被拒绝');
  eq(r1.reason, 'out_of_bounds', '原因为 out_of_bounds');

  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  eq(validatePoints(square, W, H).ok, true, '正常正方形通过');

  // 仅边相接（共线接触/共享边）允许
  const neighbor = [{ x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 }];
  ok(!polygonsOverlap(square, neighbor), '共享一条边不算重叠');
  const corner = [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }];
  ok(!polygonsOverlap(square, corner), '仅角点接触不算重叠');

  // 包含 / 真正交叉拒绝
  const inside = [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }];
  ok(polygonsOverlap(square, inside), '内部小多边形判为重叠');
  const cross = [{ x: 5, y: -5 }, { x: 5, y: 15 }, { x: 15, y: 15 }, { x: 15, y: -5 }];
  ok(polygonsOverlap(square, cross), '跨过多边形边判为重叠');
  // 同一点集判重
  const dup = square.map((p) => ({ ...p }));
  ok(polygonsOverlap(square, dup), '完全相同的多边形判为重叠');
}

/* ---------- HTTP 端到端 ---------- */

let mapId;

async function uploadPng(name, buf, mime = 'image/png') {
  const fd = new FormData();
  fd.append('image', new Blob([buf], { type: mime }), name);
  fd.append('name', name);
  const res = await fetch(`${BASE}/api/maps`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json() };
}

async function e2e() {
  console.log('\n[健康检查 / 静态页]');
  const health = await (await fetch(`${BASE}/api/health`)).json();
  ok(health.ok === true, '健康检查 200');
  const page = await fetch(`${BASE}/`);
  eq(page.status, 200, '首页可访问');
  const appjs = await fetch(`${BASE}/app.js`);
  eq(appjs.status, 200, 'app.js 可访问');

  console.log('\n[上传]');
  const png = makePng(240, 160);
  const up = await uploadPng('1号馆.png', png);
  eq(up.status, 201, '合法 PNG 上传成功');
  eq(up.body.map.width, 240, '宽度解析为 240');
  eq(up.body.map.height, 160, '高度解析为 160');
  mapId = up.body.map.id;
  ok(/^[0-9a-f-]{36}$/.test(mapId), '返回 UUID 图 ID');

  const img = await fetch(`${BASE}/api/maps/${mapId}/image`);
  eq(img.status, 200, '原图可取回');
  eq(img.headers.get('content-type'), 'image/png', 'content-type 正确');

  // 损坏图：签名对但截断
  const truncated = png.subarray(0, 40);
  const bad1 = await uploadPng('broken.png', truncated);
  eq(bad1.status, 400, '截断 PNG 被拒绝');
  eq(bad1.body.error, 'invalid_image', '错误码 invalid_image');

  // 纯垃圾字节
  const garbage = Buffer.from('not an image at all, just text'.repeat(5));
  const bad2 = await uploadPng('fake.png', garbage);
  eq(bad2.status, 400, '非图片字节被拒绝');

  const mapsAfterBad = await (await fetch(`${BASE}/api/maps`)).json();
  eq(mapsAfterBad.maps.length, 1, '失败上传未产生任何记录（无部分写入）');

  console.log('\n[区域几何拒绝]');
  const square = [{ x: 10, y: 10 }, { x: 80, y: 10 }, { x: 80, y: 80 }, { x: 10, y: 80 }];
  const a = await postRegion({ code: ' A-01 ', risk: 'high', points: square });
  eq(a.status, 201, '合法区域 A-01 创建');
  eq(a.body.region.version, 1, '新区域版本 v1');
  eq(a.body.region.code, 'A-01', '编号已 trim');

  async function postRegion(payload, method = 'POST', urlPath = `/api/maps/${mapId}/regions`) {
    const url = method === 'POST' ? `${BASE}${urlPath}` : `${BASE}${urlPath}/${payload.__id}`;
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  }

  const dupCode = await postRegion({ code: 'A-01', risk: 'low', points: [{ x: 100, y: 100 }, { x: 140, y: 100 }, { x: 140, y: 140 }, { x: 100, y: 140 }] });
  eq(dupCode.status, 409, '重复编号 409');
  eq(dupCode.body.error, 'duplicate_code', '错误码 duplicate_code');

  const bowtie = [{ x: 100, y: 10 }, { x: 180, y: 60 }, { x: 100, y: 60 }, { x: 180, y: 10 }];
  const self = await postRegion({ code: 'B-02', risk: 'low', points: bowtie });
  eq(self.status, 400, '自交多边形 400');
  eq(self.body.error, 'self_intersecting', '错误码 self_intersecting');
  ok(/自交/.test(self.body.detail), '拒绝原因含中文说明');

  const oob = await postRegion({ code: 'B-03', risk: 'low', points: [{ x: 200, y: 100 }, { x: 300, y: 100 }, { x: 200, y: 200 }] });
  eq(oob.status, 400, '越界多边形 400');
  eq(oob.body.error, 'out_of_bounds', '错误码 out_of_bounds');

  // 重叠：伸入 A-01 内部
  const overlap = await postRegion({ code: 'B-04', risk: 'medium', points: [{ x: 50, y: 50 }, { x: 120, y: 50 }, { x: 120, y: 120 }, { x: 50, y: 120 }] });
  eq(overlap.status, 409, '重叠多边形 409');
  eq(overlap.body.error, 'overlap', '错误码 overlap');
  ok(/A-01/.test(overlap.body.detail), '提示与哪个区域重叠');

  // 仅边界相接 → 允许
  const touching = await postRegion({ code: 'B-05', risk: 'low', points: [{ x: 80, y: 10 }, { x: 120, y: 10 }, { x: 120, y: 80 }, { x: 80, y: 80 }] });
  eq(touching.status, 201, '与 A-01 共享边的区域允许创建');

  // 非法风险等级 / 缺编号
  const badRisk = await postRegion({ code: 'B-06', risk: 'critical', points: [{ x: 150, y: 100 }, { x: 180, y: 100 }, { x: 180, y: 130 }] });
  eq(badRisk.status, 400, '非法风险等级 400');
  const noCode = await postRegion({ code: '   ', risk: 'low', points: [{ x: 150, y: 100 }, { x: 180, y: 100 }, { x: 180, y: 130 }] });
  eq(noCode.status, 400, '空编号 400');

  console.log('\n[乐观锁 / 版本]');
  const regionAId = a.body.region.id;
  const oldRes = await fetch(`${BASE}/api/maps/${mapId}/regions/${regionAId}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'A-01', risk: 'medium', points: square, expectedVersion: 99 }),
  });
  const oldBody = await oldRes.json();
  eq(oldRes.status, 409, '旧版本(v99)更新被拒绝');
  eq(oldBody.error, 'version_conflict', '错误码 version_conflict');

  const moved = [{ x: 12, y: 12 }, { x: 70, y: 12 }, { x: 70, y: 70 }, { x: 12, y: 70 }];
  const okPut = await fetch(`${BASE}/api/maps/${mapId}/regions/${regionAId}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'A-01', risk: 'medium', points: moved, expectedVersion: 1 }),
  });
  const okBody = await okPut.json();
  eq(okPut.status, 200, '正确版本(v1)更新成功');
  eq(okBody.region.version, 2, '版本推进到 v2');
  eq(okBody.region.risk, 'medium', '风险等级已更新');

  // 再用 v1 提交 → 冲突
  const stale = await fetch(`${BASE}/api/maps/${mapId}/regions/${regionAId}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'A-01', risk: 'high', points: moved, expectedVersion: 1 }),
  });
  eq(stale.status, 409, '并发旧版(v1)再次提交冲突');
  const unchanged = await (await fetch(`${BASE}/api/maps/${mapId}`)).json();
  const stillA = unchanged.map.regions.find((r) => r.id === regionAId);
  eq(stillA.version, 2, '冲突提交未改动数据');
  eq(stillA.risk, 'medium', '内容保持为 v2');

  console.log('\n[删除后旧提交不可恢复]');
  const del = await fetch(`${BASE}/api/maps/${mapId}/regions/${regionAId}?expectedVersion=2`, { method: 'DELETE' });
  eq(del.status, 200, '基于 v2 删除成功');
  const afterDel = await (await fetch(`${BASE}/api/maps/${mapId}`)).json();
  ok(!afterDel.map.regions.some((r) => r.id === regionAId), '列表中不再出现');

  const zombiePut = await fetch(`${BASE}/api/maps/${mapId}/regions/${regionAId}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'A-01', risk: 'high', points: moved, expectedVersion: 2 }),
  });
  eq(zombiePut.status, 409, '删除后旧版 PUT 不能复活区域');
  const zombieDel = await fetch(`${BASE}/api/maps/${mapId}/regions/${regionAId}?expectedVersion=2`, { method: 'DELETE' });
  eq(zombieDel.status, 409, '删除后旧版 DELETE 同样被拒绝');
  const finalMap = await (await fetch(`${BASE}/api/maps/${mapId}`)).json();
  ok(!finalMap.map.regions.some((r) => r.id === regionAId), '区域仍处于删除状态');

  // 删除冲突：B-05 当前 v1
  const b05 = finalMap.map.regions.find((r) => r.code === 'B-05');
  const delWrong = await fetch(`${BASE}/api/maps/${mapId}/regions/${b05.id}?expectedVersion=42`, { method: 'DELETE' });
  eq(delWrong.status, 409, '错误版本删除冲突');

  // 编号已随删除释放：同编号可用于新区域
  const reuse = await postRegion({ code: 'A-01', risk: 'low', points: [{ x: 130, y: 130 }, { x: 160, y: 130 }, { x: 160, y: 150 }] });
  eq(reuse.status, 201, '删除后编号 A-01 可复用');
  // 清理掉复用区域，使后续导出断言保持单区域
  const delReuse = await fetch(`${BASE}/api/maps/${mapId}/regions/${reuse.body.region.id}?expectedVersion=1`, { method: 'DELETE' });
  eq(delReuse.status, 200, '复用区域清理成功');

  console.log('\n[SSE 实时事件补发]');
  const sse = await sseOnce(0);
  ok(!!sse && sse.includes('event: change'), 'SSE 补发历史 change 事件');

  console.log('\n[导出 / 导入往返]');
  const expRes = await fetch(`${BASE}/api/maps/${mapId}/export`);
  eq(expRes.status, 200, '导出 200');
  const exported = await expRes.json();
  eq(exported.format, 'floorplan-annotator/v1', '导出格式标识正确');
  eq(exported.maps[0].meta.width, 240, '导出保持宽度');
  eq(exported.maps[0].meta.height, 160, '导出保持高度');
  const versionBefore = exported.maps[0].meta.version;
  ok(versionBefore >= 1, `导出版本号存在 (v${versionBefore})`);
  const expCodes = exported.maps[0].regions.map((r) => r.code).sort();
  ok(JSON.stringify(expCodes) === JSON.stringify(['B-05']), `导出剩余区域 B-05（实际 ${expCodes}）`);
  const b05ver = exported.maps[0].regions[0].version;
  eq(b05ver, 1, '区域版本随导出保留');
  const imgB64 = exported.maps[0].imageBase64;
  eq(Buffer.from(imgB64, 'base64').equals(png), true, '导出图片字节与原图一致');

  // 原样导回：尺寸/区域/版本都保持
  const reimport = await fetch(`${BASE}/api/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(exported),
  });
  eq(reimport.status, 200, '重新导入成功');
  const afterImport = await (await fetch(`${BASE}/api/maps/${mapId}`)).json();
  eq(afterImport.map.width, 240, '导入后宽度一致');
  eq(afterImport.map.height, 160, '导入后高度一致');
  eq(afterImport.map.version, versionBefore, `图版本保持 v${versionBefore}`);
  eq(afterImport.map.regions.length, 1, '区域数量一致');
  eq(afterImport.map.regions[0].version, 1, '区域版本保持 v1');
  eq(afterImport.map.regions[0].code, 'B-05', '区域编号一致');
  const reImg = await (await fetch(`${BASE}/api/maps/${mapId}/image`)).blob();
  eq(reImg.size, png.length, '导入后图片字节一致');

  console.log('\n[坏数据导入：整体拒绝，无部分写入]');
  // 1) 非 JSON
  const badJson = await fetch(`${BASE}/api/import`, { method: 'POST', body: '{not json' });
  eq(badJson.status, 400, '非 JSON 400');

  // 2) 错误格式标识
  const badFmt = await fetch(`${BASE}/api/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ format: 'something/else', maps: [] }),
  });
  eq(badFmt.status, 400, '格式标识错误被拒绝');

  // 3) 图片损坏（篡改 base64）
  const corruptDoc = JSON.parse(JSON.stringify(exported));
  corruptDoc.maps[0].imageBase64 = Buffer.from('garbage-bytes-here').toString('base64');
  const corruptImport = await fetch(`${BASE}/api/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corruptDoc),
  });
  eq(corruptImport.status, 400, '损坏图片的导入被拒绝');

  // 4) 数据自相矛盾（两个区域重叠）
  const contradict = JSON.parse(JSON.stringify(exported));
  contradict.maps[0].regions.push({
    id: '11111111-1111-1111-1111-111111111111',
    code: 'X-99', risk: 'high',
    points: [[10, 10], [100, 10], [100, 100], [10, 100]].map(([x, y]) => ({ x, y })),
    version: 1, createdAt: Date.now(), updatedAt: Date.now(),
  });
  // B-05 位于 (80,10)-(120,80)，新矩形与之重叠
  const contraRes = await fetch(`${BASE}/api/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(contradict),
  });
  eq(contraRes.status, 400, '互相重叠的导入数据被拒绝');
  const contraBody = await contraRes.json();
  ok(/重叠/.test(contraBody.detail), '说明重叠原因');

  // 5) 顶点越界
  const oobDoc = JSON.parse(JSON.stringify(exported));
  oobDoc.maps[0].regions = [{
    id: '22222222-2222-2222-2222-222222222222',
    code: 'Y-01', risk: 'low',
    points: [{ x: 0, y: 0 }, { x: 9999, y: 0 }, { x: 0, y: 9999 }],
    version: 1, createdAt: Date.now(), updatedAt: Date.now(),
  }];
  const oobRes = await fetch(`${BASE}/api/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(oobDoc),
  });
  eq(oobRes.status, 400, '越界顶点的导入数据被拒绝');

  // 验证全部失败导入后，数据库仍是上次成功导入的状态（无部分写入）
  const intact = await (await fetch(`${BASE}/api/maps/${mapId}`)).json();
  eq(intact.map.regions.length, 1, '失败导入后区域仍是 1 个');
  eq(intact.map.regions[0].code, 'B-05', '失败导入后内容保持 B-05');
  eq(intact.map.version, versionBefore, `图版本仍为 v${versionBefore}`);

  // 失败导入不能影响文档外的其它图
  const up2 = await uploadPng('2号馆.png', makePng(80, 60));
  eq(up2.status, 201, '第二张图上传成功（用于验证导入隔离）');
  const otherId = up2.body.map.id;
  const corrupt2 = await fetch(`${BASE}/api/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corruptDoc), // 损坏图片的第一张图文档
  });
  eq(corrupt2.status, 400, '针对第一张图的坏导入再次被拒绝');
  const otherStill = await fetch(`${BASE}/api/maps/${otherId}`);
  eq(otherStill.status, 200, '文档外的第二张图完全不受影响');
  const otherBody = await otherStill.json();
  eq(otherBody.map.width, 80, '第二张图尺寸保持 80');

  console.log('\n[404 路由]');
  const nf = await fetch(`${BASE}/api/maps/00000000-0000-0000-0000-000000000000`);
  eq(nf.status, 404, '不存在的图返回 404');
}

/* ---------- 主流程 ---------- */

const proc = spawn(process.execPath, ['server/index.js'], {
  cwd: path.join(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: dbPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
proc.log = '';
proc.stdout.on('data', (d) => { proc.log += d; });
proc.stderr.on('data', (d) => { proc.log += d; });

try {
  await waitHealthy(proc);
  unitGeometry();
  await e2e();
} catch (err) {
  console.error('\n💥 测试异常：', err);
  if (proc.log) console.error('--- server log ---\n' + proc.log);
  failed++;
} finally {
  proc.kill('SIGTERM');
  setTimeout(() => {
    rmSync(dir, { recursive: true, force: true });
    console.log(`\n========================================`);
    console.log(`通过 ${passed} 项，失败 ${failed} 项`);
    process.exit(failed === 0 ? 0 : 1);
  }, 200);
}
