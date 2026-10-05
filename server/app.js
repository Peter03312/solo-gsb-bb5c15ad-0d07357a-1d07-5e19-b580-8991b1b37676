'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('./config');
const { openDb } = require('./db');
const { readImageSize } = require('./image');
const geom = require('../shared/geometry');

const RISK_LEVELS = ['低风险', '中风险', '高风险'];
const EXPORT_FORMAT = 'hall-plan-annotator-export/v1';

const db = openDb();
const app = express();
app.use(express.json({ limit: config.maxImportBytes() })); // /api/import 使用 JSON
app.use(express.urlencoded({ extended: false }));

// 静态资源：前端页面与共享几何库
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ----------------------------- 工具函数 ----------------------------- */

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function sendError(res, err) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: err.code,
      message: err.message,
      ...err.extra,
    });
  }
  console.error(err);
  return res.status(500).json({ error: 'INTERNAL', message: '服务器内部错误' });
}

/** 包一层，使 async/同步路由错误统一进入错误处理 */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function rowToRegion(r) {
  return {
    id: r.id,
    code: r.code,
    risk_level: r.risk_level,
    vertices: JSON.parse(r.vertices),
    version: r.version,
    deleted: !!r.deleted,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function activeRegions(planId) {
  return db.prepare(
    'SELECT * FROM regions WHERE plan_id = ? AND deleted = 0 ORDER BY id'
  ).all(planId).map(rowToRegion);
}

function getPlanOr404(planId) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!plan) throw new ApiError(404, 'NOT_FOUND', `平面图 id=${planId} 不存在`);
  return plan;
}

/** 构造冲突/删除响应中附带的最新服务端状态，便于客户端直接刷新 */
function serverSnapshot(plan, regionRow) {
  return {
    plan_version: plan.version,
    regions: activeRegions(plan.id),
    region: regionRow
      ? { id: regionRow.id, version: regionRow.version, deleted: !!regionRow.deleted, code: regionRow.code }
      : null,
  };
}

/** 规范化顶点：四舍五入到 0.001 像素，消除浮点噪声后做范围校验/夹取 */
function normalizeVertices(input, image) {
  if (!Array.isArray(input)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'vertices 必须是数组');
  }
  const EPS = 1e-6;
  return input.map((p, i) => {
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' ||
        !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new ApiError(400, 'VALIDATION_ERROR',
        `第 ${i + 1} 个顶点坐标无效（必须为有限数字）`);
    }
    let x = Math.round(p.x * 1000) / 1000;
    let y = Math.round(p.y * 1000) / 1000;
    if (x < -EPS || y < -EPS || x > image.width + EPS || y > image.height + EPS) {
      throw new ApiError(400, 'VALIDATION_ERROR',
        `第 ${i + 1} 个顶点 (${fmt(p.x)}, ${fmt(p.y)}) 越界：原图范围为 0–${image.width} × 0–${image.height} 像素`);
    }
    return { x: Math.min(image.width, Math.max(0, x)), y: Math.min(image.height, Math.max(0, y)) };
  });
}

function fmt(n) { return Math.round(n * 100) / 100; }

function validateFields(body) {
  const code = String(body.code == null ? '' : body.code).trim();
  if (!code) throw new ApiError(400, 'VALIDATION_ERROR', '区域编号不能为空');
  if (code.length > 64) throw new ApiError(400, 'VALIDATION_ERROR', '区域编号不能超过 64 个字符');

  const riskLevel = String(body.risk_level == null ? '' : body.risk_level).trim();
  if (!RISK_LEVELS.includes(riskLevel)) {
    throw new ApiError(400, 'VALIDATION_ERROR',
      `风险等级无效，必须是：${RISK_LEVELS.join(' / ')}`);
  }
  return { code, riskLevel };
}

function requireVersion(body) {
  const v = Number(body.version);
  if (!Number.isInteger(v) || v < 1) {
    throw new ApiError(400, 'VALIDATION_ERROR', '缺少有效的区域版本号 version（正整数）');
  }
  return v;
}

/** 计划级版本检查（多人协作的整图乐观锁） */
function checkPlanVersion(body, plan) {
  if (body.plan_version != null) {
    const pv = Number(body.plan_version);
    if (!Number.isInteger(pv) || pv < 1) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'plan_version 必须为正整数');
    }
    if (pv !== plan.version) {
      throw new ApiError(409, 'PLAN_VERSION_CONFLICT',
        `平面图已被其他人修改（你的基准版本 v${pv}，当前版本 v${plan.version}）。未提交的编辑已保留，请刷新区域数据后重试。`,
        { server: serverSnapshot(plan) });
    }
  }
}

const extOf = (mime) => (mime === 'image/png' ? '.png' : '.jpg');

/** 校验通过后写文件：先写临时文件再原子改名，失败不留半成品 */
function storeImageFile(id, buf, mime) {
  const finalPath = path.join(config.uploadDir(), `${id}${extOf(mime)}`);
  const tmpPath = path.join(config.uploadDir(),
    `.tmp-${process.pid}-${id}-${Date.now()}${extOf(mime)}`);
  try {
    fs.writeFileSync(tmpPath, buf);
    fs.renameSync(tmpPath, finalPath); // 同卷原子替换
  } catch (e) {
    try { fs.existsSync(tmpPath) && fs.unlinkSync(tmpPath); } catch (_) {}
    throw e;
  }
  return path.basename(finalPath);
}

/* ----------------------------- multer 上传 ----------------------------- */

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes(), files: 1 },
  fileFilter: (req, file, cb) => {
    if (config.allowedMime.has(file.mimetype)) return cb(null, true);
    cb(new ApiError(415, 'UNSUPPORTED_TYPE',
      `仅支持 PNG / JPEG 图片，收到的类型为：${file.mimetype || '未知'}`));
  },
});

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxImportBytes(), files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/json' || /\.json$/i.test(file.originalname)) {
      return cb(null, true);
    }
    cb(new ApiError(415, 'UNSUPPORTED_TYPE', '导入文件必须是导出的 .json 文件'));
  },
});

// multer 异步错误（如超限）经 next(err) 进入统一错误处理；成功则放行到路由
function uploader(upload, field) {
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (err) {
        if (err instanceof ApiError) return next(err);
        if (err && err.code === 'LIMIT_FILE_SIZE') {
          return next(new ApiError(413, 'PAYLOAD_TOO_LARGE',
            `文件过大，上限 ${config.maxUploadMb}MB（可通过 MAX_UPLOAD_MB 调整）`));
        }
        return next(err);
      }
      next();
    });
  };
}

/* ----------------------------- 平面图接口 ----------------------------- */

// 新建平面图（上传 PNG/JPEG）
app.post('/api/plans', uploader(imageUpload, 'image'), wrap((req, res) => {
  if (!req.file) {
    throw new ApiError(400, 'VALIDATION_ERROR', '缺少上传文件字段 image（PNG/JPEG）');
  }
  let dims;
  try {
    dims = readImageSize(req.file.buffer, req.file.mimetype);
  } catch (e) {
    throw new ApiError(400, 'BAD_IMAGE', `图片损坏或无法解析：${e.message}`);
  }
  if (dims.mime !== req.file.mimetype) {
    throw new ApiError(400, 'BAD_IMAGE',
      `文件实际内容为 ${dims.mime}，与上传声明的 ${req.file.mimetype} 不符`);
  }
  const finalName = (req.body.name || '').trim() ||
    path.parse(req.file.originalname).name.slice(0, 200) || '未命名平面图';

  const result = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO plans (name, image_file, image_mime, width, height)
      VALUES (@name, '', @mime, @w, @h)
    `).run({ name: finalName.slice(0, 200), mime: dims.mime, w: dims.width, h: dims.height });
    const imageFile = storeImageFile(info.lastInsertRowid, req.file.buffer, dims.mime);
    db.prepare('UPDATE plans SET image_file = ? WHERE id = ?').run(imageFile, info.lastInsertRowid);
    return info.lastInsertRowid;
  })();

  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(result);
  res.status(201).json({ plan: planJson(plan), regions: [] });
}));

// 平面图列表
app.get('/api/plans', wrap((req, res) => {
  const rows = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM regions r WHERE r.plan_id = p.id AND r.deleted = 0) AS region_count
    FROM plans p ORDER BY p.id DESC
  `).all();
  res.json({ plans: rows.map((p) => ({
    id: p.id, name: p.name, width: p.width, height: p.height,
    version: p.version, region_count: p.region_count,
    created_at: p.created_at, updated_at: p.updated_at,
  })) });
}));

// 平面图详情（含全部未删除区域）
app.get('/api/plans/:id', wrap((req, res) => {
  const plan = getPlanOr404(req.params.id);
  res.json({ plan: planJson(plan), regions: activeRegions(plan.id) });
}));

// 原图
app.get('/api/plans/:id/image', wrap((req, res) => {
  const plan = getPlanOr404(req.params.id);
  const file = path.join(config.uploadDir(), plan.image_file);
  if (!fs.existsSync(file)) {
    throw new ApiError(410, 'IMAGE_MISSING', '原图文件在数据目录中缺失');
  }
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Type', plan.image_mime);
  fs.createReadStream(file).on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'INTERNAL', message: '读取图片失败' });
  }).pipe(res);
}));

// 更新平面图名称 / 替换原图（新图必须与原图同尺寸，否则已有区域坐标会失效）
app.put('/api/plans/:id', uploader(imageUpload, 'image'), wrap((req, res) => {
  const plan = getPlanOr404(req.params.id);
  let newMime = plan.image_mime;
  let newBuf = null;
  if (req.file) {
    let dims;
    try {
      dims = readImageSize(req.file.buffer, req.file.mimetype);
    } catch (e) {
      throw new ApiError(400, 'BAD_IMAGE', `替换图片损坏或无法解析：${e.message}`);
    }
    if (dims.mime !== req.file.mimetype) {
      throw new ApiError(400, 'BAD_IMAGE',
        `替换图片实际内容为 ${dims.mime}，与上传声明的 ${req.file.mimetype} 不符`);
    }
    if (dims.width !== plan.width || dims.height !== plan.height) {
      throw new ApiError(400, 'BAD_IMAGE',
        `替换图片尺寸为 ${dims.width}×${dims.height}，与原图 ${plan.width}×${plan.height} 不一致。` +
        `顶点按原图坐标保存，尺寸变化会导致已有区域错位，已拒绝写入。`);
    }
    newMime = dims.mime;
    newBuf = req.file.buffer;
  }
  const name = (req.body.name || '').trim();
  if (name && name.length > 200) {
    throw new ApiError(400, 'VALIDATION_ERROR', '名称不能超过 200 个字符');
  }

  db.transaction(() => {
    db.prepare(`UPDATE plans SET
        name = COALESCE(NULLIF(?, ''), name),
        image_mime = ?,
        version = version + 1,
        updated_at = datetime('now')
      WHERE id = ?`).run(name, newMime, plan.id);
    if (newBuf) {
      // 清除旧扩展名不同的旧文件
      const oldFile = path.join(config.uploadDir(), plan.image_file);
      const newFile = storeImageFile(plan.id, newBuf, newMime);
      db.prepare('UPDATE plans SET image_file = ? WHERE id = ?').run(newFile, plan.id);
      if (plan.image_file && path.basename(oldFile) !== newFile && fs.existsSync(oldFile)) {
        fs.unlinkSync(oldFile);
      }
    }
  })();

  const fresh = getPlanOr404(plan.id);
  res.json({ plan: planJson(fresh), regions: activeRegions(fresh.id) });
}));

/* --------------------------- 区域增 / 改 / 删 --------------------------- */

app.post('/api/plans/:id/regions', wrap((req, res) => {
  const plan = getPlanOr404(req.params.id);
  checkPlanVersion(req.body, plan);
  const { code, riskLevel } = validateFields(req.body);
  const vertices = normalizeVertices(req.body.vertices, plan);

  const selfErr = geom.validateVertices(vertices, { width: plan.width, height: plan.height });
  if (selfErr) throw new ApiError(400, 'VALIDATION_ERROR', selfErr);

  const out = db.transaction(() => {
    const others = activeRegions(plan.id);
    const dup = others.find((r) => r.code === code);
    if (dup) {
      throw new ApiError(409, 'CODE_CONFLICT',
        `编号「${code}」已被区域 id=${dup.id} 使用，同一图上编号必须唯一`,
        { server: serverSnapshot(plan) });
    }
    const ov = geom.validateOverlap(others, vertices);
    if (ov) throw new ApiError(400, 'VALIDATION_ERROR', ov);

    const info = db.prepare(`
      INSERT INTO regions (plan_id, code, risk_level, vertices, version)
      VALUES (?, ?, ?, ?, 1)
    `).run(plan.id, code, riskLevel, JSON.stringify(vertices));
    bumpPlan(plan.id);
    return info.lastInsertRowid;
  })();

  const freshPlan = getPlanOr404(plan.id);
  const row = db.prepare('SELECT * FROM regions WHERE id = ?').get(out);
  res.status(201).json({
    plan_version: freshPlan.version,
    region: rowToRegion(row),
    regions: activeRegions(plan.id),
  });
}));

app.put('/api/plans/:id/regions/:rid', wrap((req, res) => {
  const plan = getPlanOr404(req.params.id);
  checkPlanVersion(req.body, plan);
  const expectedVersion = requireVersion(req.body);
  const { code, riskLevel } = validateFields(req.body);
  const vertices = normalizeVertices(req.body.vertices, plan);

  const selfErr = geom.validateVertices(vertices, { width: plan.width, height: plan.height });
  if (selfErr) throw new ApiError(400, 'VALIDATION_ERROR', selfErr);

  db.transaction(() => {
    const row = db.prepare('SELECT * FROM regions WHERE id = ? AND plan_id = ?')
      .get(req.params.rid, plan.id);
    if (!row) {
      throw new ApiError(404, 'NOT_FOUND', `区域 id=${req.params.rid} 不存在`);
    }
    if (row.deleted) {
      throw new ApiError(410, 'REGION_DELETED',
        `区域「${row.code}」已被删除（删除时版本 v${row.version}）。` +
        `删除不可撤销，基于旧版本的提交无法恢复该区域；如需在原位置标注请新建区域。`,
        { server: serverSnapshot(plan, row) });
    }
    if (row.version !== expectedVersion) {
      throw new ApiError(409, 'VERSION_CONFLICT',
        `区域「${row.code}」已被其他人更新（你编辑的是 v${expectedVersion}，当前为 v${row.version}）。` +
        `未提交的编辑已保留，请刷新后合并再提交。`,
        { server: serverSnapshot(plan, row) });
    }
    const others = activeRegions(plan.id).filter((r) => r.id !== row.id);
    const dup = others.find((r) => r.code === code);
    if (dup) {
      throw new ApiError(409, 'CODE_CONFLICT',
        `编号「${code}」已被区域 id=${dup.id} 使用，同一图上编号必须唯一`,
        { server: serverSnapshot(plan, row) });
    }
    const ov = geom.validateOverlap(others, vertices);
    if (ov) throw new ApiError(400, 'VALIDATION_ERROR', ov);

    db.prepare(`
      UPDATE regions SET code = ?, risk_level = ?, vertices = ?,
        version = version + 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(code, riskLevel, JSON.stringify(vertices), row.id);
    bumpPlan(plan.id);
  })();

  const freshPlan = getPlanOr404(plan.id);
  const row = db.prepare('SELECT * FROM regions WHERE id = ?').get(req.params.rid);
  res.json({
    plan_version: freshPlan.version,
    region: rowToRegion(row),
    regions: activeRegions(plan.id),
  });
}));

app.delete('/api/plans/:id/regions/:rid', wrap((req, res) => {
  const plan = getPlanOr404(req.params.id);
  // version 可放在 query 或 body（DELETE 通常无 body）
  const expectedVersion = requireVersion(req.query.version != null ? req.query : req.body || {});
  checkPlanVersion(req.query.plan_version != null ? req.query : req.body || {}, plan);

  db.transaction(() => {
    const row = db.prepare('SELECT * FROM regions WHERE id = ? AND plan_id = ?')
      .get(req.params.rid, plan.id);
    if (!row) throw new ApiError(404, 'NOT_FOUND', `区域 id=${req.params.rid} 不存在`);
    if (row.deleted) {
      throw new ApiError(410, 'REGION_DELETED',
        `区域「${row.code}」已经处于删除状态（v${row.version}），无需重复删除`,
        { server: serverSnapshot(plan, row) });
    }
    if (row.version !== expectedVersion) {
      throw new ApiError(409, 'VERSION_CONFLICT',
        `区域「${row.code}」在你加载后已被修改（v${expectedVersion} → v${row.version}），` +
        `为避免删掉他人的修改，本次删除被拒绝，请刷新后确认再删。`,
        { server: serverSnapshot(plan, row) });
    }
    db.prepare(`
      UPDATE regions SET deleted = 1, version = version + 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(row.id);
    bumpPlan(plan.id);
  })();

  const freshPlan = getPlanOr404(plan.id);
  res.json({ plan_version: freshPlan.version, regions: activeRegions(plan.id) });
}));

function bumpPlan(planId) {
  db.prepare("UPDATE plans SET version = version + 1, updated_at = datetime('now') WHERE id = ?")
    .run(planId);
}

/* ----------------------------- 导出 / 导入 ----------------------------- */

function planJson(p) {
  return {
    id: p.id, name: p.name, width: p.width, height: p.height,
    version: p.version, image_mime: p.image_mime,
    created_at: p.created_at, updated_at: p.updated_at,
  };
}

// 整图导出：尺寸 + 区域 + 版本 + 原图(base64) 全部自包含
app.get('/api/plans/:id/export', wrap((req, res) => {
  const plan = getPlanOr404(req.params.id);
  const file = path.join(config.uploadDir(), plan.image_file);
  if (!fs.existsSync(file)) throw new ApiError(410, 'IMAGE_MISSING', '原图文件缺失，无法导出');
  const payload = {
    format: EXPORT_FORMAT,
    exported_at: new Date().toISOString(),
    plan: {
      name: plan.name,
      width: plan.width,
      height: plan.height,
      version: plan.version,
      image: { mime: plan.image_mime, dataBase64: fs.readFileSync(file).toString('base64') },
    },
    regions: activeRegions(plan.id).map((r) => ({
      code: r.code,
      risk_level: r.risk_level,
      vertices: r.vertices,
      version: r.version,
    })),
  };
  res.setHeader('Content-Disposition',
    `attachment; filename="plan-${plan.id}-v${plan.version}.json"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(payload, null, 2));
}));

/**
 * 导入前的完整校验，任何一项不过都抛错（此时尚未进行任何写入）。
 * 返回规范化后的数据对象。
 */
function parseAndValidateImport(raw, nameOverride) {
  let data;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    throw new ApiError(400, 'BAD_IMPORT', `导入数据不是合法 JSON：${e.message}`);
  }
  if (!data || typeof data !== 'object' || data.format !== EXPORT_FORMAT) {
    throw new ApiError(400, 'BAD_IMPORT',
      `导入数据格式标识无效（应为 ${EXPORT_FORMAT}），请选择本应用导出的 JSON 文件`);
  }
  const p = data.plan;
  if (!p || typeof p !== 'object') {
    throw new ApiError(400, 'BAD_IMPORT', '缺少 plan 字段');
  }
  const name = String(nameOverride || p.name || '').trim();
  if (!name || name.length > 200) {
    throw new ApiError(400, 'BAD_IMPORT', '平面图名称缺失或超过 200 字符');
  }
  if (!Number.isInteger(p.width) || !Number.isInteger(p.height) || p.width < 1 || p.height < 1) {
    throw new ApiError(400, 'BAD_IMPORT', '平面图尺寸字段 width/height 非法');
  }
  if (!Number.isInteger(p.version) || p.version < 1) {
    throw new ApiError(400, 'BAD_IMPORT', '平面图版本号 version 非法（应为正整数）');
  }
  if (!p.image || !config.allowedMime.has(p.image.mime) || typeof p.image.dataBase64 !== 'string') {
    throw new ApiError(400, 'BAD_IMPORT', '图片字段无效：需要 mime=image/png|image/jpeg 与 dataBase64');
  }
  let imageBuf;
  try {
    imageBuf = Buffer.from(p.image.dataBase64, 'base64');
  } catch (_) {
    throw new ApiError(400, 'BAD_IMPORT', '图片 base64 解码失败');
  }
  if (!imageBuf.length) {
    throw new ApiError(400, 'BAD_IMPORT', '图片数据为空');
  }
  let detected;
  try {
    detected = readImageSize(imageBuf, p.image.mime);
  } catch (e) {
    throw new ApiError(400, 'BAD_IMPORT', `导入包中的图片损坏：${e.message}`);
  }
  if (detected.mime !== p.image.mime) {
    throw new ApiError(400, 'BAD_IMPORT',
      `图片实际内容为 ${detected.mime}，与导出记录的 ${p.image.mime} 不符`);
  }
  if (detected.width !== p.width || detected.height !== p.height) {
    throw new ApiError(400, 'BAD_IMPORT',
      `图片实际尺寸 ${detected.width}×${detected.height} 与记录尺寸 ${p.width}×${p.height} 不一致`);
  }

  if (!Array.isArray(data.regions)) {
    throw new ApiError(400, 'BAD_IMPORT', 'regions 必须是数组');
  }
  if (data.regions.length > 5000) {
    throw new ApiError(400, 'BAD_IMPORT', '区域数量超过上限 5000');
  }

  const image = { width: p.width, height: p.height };
  const codes = new Set();
  const regions = data.regions.map((r, i) => {
    const where = `第 ${i + 1} 个区域`;
    if (!r || typeof r !== 'object') {
      throw new ApiError(400, 'BAD_IMPORT', `${where} 不是对象`);
    }
    const code = String(r.code == null ? '' : r.code).trim();
    if (!code || code.length > 64) {
      throw new ApiError(400, 'BAD_IMPORT', `${where} 编号缺失或超过 64 字符`);
    }
    if (codes.has(code)) {
      throw new ApiError(400, 'BAD_IMPORT', `${where} 编号「${code}」在文件内重复，编号必须唯一`);
    }
    codes.add(code);
    if (!RISK_LEVELS.includes(String(r.risk_level || '').trim())) {
      throw new ApiError(400, 'BAD_IMPORT',
        `${where}（${code}）风险等级无效：${r.risk_level}`);
    }
    if (!Number.isInteger(r.version) || r.version < 1) {
      throw new ApiError(400, 'BAD_IMPORT', `${where}（${code}）版本号非法（应为正整数）`);
    }
    const verts = normalizeImportVertices(r.vertices, image, where);
    const err = geom.validateVertices(verts, image);
    if (err) throw new ApiError(400, 'BAD_IMPORT', `${where}（${code}）${err}`);
    return { code, risk_level: String(r.risk_level).trim(), vertices: verts, version: r.version };
  });

  // 两两不重叠（自交已在上面拒绝）
  for (let i = 0; i < regions.length; i++) {
    const others = regions.slice(0, i).map((r, j) => ({ id: j + 1, code: r.code, vertices: r.vertices }));
    const ov = geom.validateOverlap(others, regions[i].vertices);
    if (ov) throw new ApiError(400, 'BAD_IMPORT', `区域「${regions[i].code}」${ov}`);
  }

  return { name, version: p.version, mime: p.image.mime, imageBuf, width: p.width, height: p.height, regions };
}

function normalizeImportVertices(input, image, where) {
  if (!Array.isArray(input)) {
    throw new ApiError(400, 'BAD_IMPORT', `${where} 的 vertices 必须是数组`);
  }
  const EPS = 1e-6;
  return input.map((pt, i) => {
    if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number' ||
        !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      throw new ApiError(400, 'BAD_IMPORT', `${where} 第 ${i + 1} 个顶点坐标无效`);
    }
    const x = Math.round(pt.x * 1000) / 1000;
    const y = Math.round(pt.y * 1000) / 1000;
    if (x < -EPS || y < -EPS || x > image.width + EPS || y > image.height + EPS) {
      throw new ApiError(400, 'BAD_IMPORT',
        `${where} 第 ${i + 1} 个顶点 (${fmt(pt.x)}, ${fmt(pt.y)}) 越界：` +
        `超出原图范围 (${image.width}×${image.height})`);
    }
    return { x: Math.min(image.width, Math.max(0, x)), y: Math.min(image.height, Math.max(0, y)) };
  });
}

/** 实际落库：全部成功或全部回滚，绝不产生部分写入 */
function commitImport(parsed) {
  const exists = db.prepare('SELECT id FROM plans WHERE name = ?').get(parsed.name);
  if (exists) {
    throw new ApiError(409, 'NAME_CONFLICT',
      `已存在同名平面图「${parsed.name}」，请改名后再导入（界面中可指定新名称）`);
  }
  let planId = null;
  try {
    const tx = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO plans (name, image_file, image_mime, width, height, version)
        VALUES (@name, '', @mime, @w, @h, @version)
      `).run({
        name: parsed.name, mime: parsed.mime,
        w: parsed.width, h: parsed.height, version: parsed.version,
      });
      planId = info.lastInsertRowid;

      // 临时文件 + 原子改名；若后续语句失败，事务回滚并清理文件
      const finalName = storeImageFile(planId, parsed.imageBuf, parsed.mime);
      db.prepare('UPDATE plans SET image_file = ? WHERE id = ?').run(finalName, planId);

      const stmt = db.prepare(`
        INSERT INTO regions (plan_id, code, risk_level, vertices, version)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const r of parsed.regions) {
        stmt.run(planId, r.code, r.risk_level, JSON.stringify(r.vertices), r.version);
      }
    });
    tx();
  } catch (e) {
    if (planId) {
      // 事务已回滚则行不存在；防御性清理可能残留的图片文件
      const f = path.join(config.uploadDir(), `${planId}${extOf(parsed.mime)}`);
      if (fs.existsSync(f)) { try { fs.unlinkSync(f); } catch (_) {} }
    }
    throw e;
  }
  return planId;
}

// 导入：支持 application/json 直接提交
app.post('/api/import', wrap(async (req, res) => {
  let raw;
  let nameOverride = null;
  if (Buffer.isBuffer(req.body)) {
    raw = req.body;
  } else if (req.is('application/json')) {
    raw = Buffer.from(JSON.stringify(req.body), 'utf8');
    nameOverride = req.body && req.body.__importName;
  } else {
    throw new ApiError(400, 'BAD_IMPORT', '请以 application/json 或 multipart 表单上传导出的 JSON 文件');
  }
  const parsed = parseAndValidateImport(raw, nameOverride);
  const planId = commitImport(parsed);
  const plan = getPlanOr404(planId);
  res.status(201).json({
    plan: planJson(plan),
    regions: activeRegions(planId),
    imported_regions: parsed.regions.length,
  });
}));

// 导入：multipart 文件方式（前端使用此方式，可附带 name 覆盖）
app.post('/api/import/file', uploader(importUpload, 'file'), wrap((req, res) => {
  if (!req.file) throw new ApiError(400, 'BAD_IMPORT', '缺少上传字段 file（导出的 .json）');
  const parsed = parseAndValidateImport(req.file.buffer, (req.body.name || '').trim());
  const planId = commitImport(parsed);
  const plan = getPlanOr404(planId);
  res.status(201).json({
    plan: planJson(plan),
    regions: activeRegions(planId),
    imported_regions: parsed.regions.length,
  });
}));

/* ------------------------------- 错误处理 ------------------------------- */

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'BAD_IMPORT', message: '请求体不是合法 JSON' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'PAYLOAD_TOO_LARGE',
      message: `数据体积超过上限（上传 ${config.maxUploadMb}MB，导入 ${config.maxUploadMb + 16}MB，可用 MAX_UPLOAD_MB 调整）`,
    });
  }
  sendError(res, err);
});

const server = app.listen(config.port, config.host, () => {
  console.log('展馆平面图协作标注已启动');
  console.log(`监听地址: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`数据目录: ${config.dataDir}`);
});

process.on('SIGTERM', () => server.close(() => db.close()));
process.on('SIGINT', () => server.close(() => db.close()));

module.exports = app;
