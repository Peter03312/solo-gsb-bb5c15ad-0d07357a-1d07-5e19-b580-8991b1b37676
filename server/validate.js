/**
 * server/validate.js — 区域与整图快照的业务校验
 */
import { validatePoints, polygonsOverlap, polygonArea } from '../shared/geometry.js';

export const RISK_LEVELS = ['low', 'medium', 'high'];
export const RISK_LABEL = { low: '低风险', medium: '中风险', high: '高风险' };
export const MAX_CODE_LENGTH = 64;
export const MAX_NAME_LENGTH = 128;
export const MAX_SNAPSHOT_MAPS = 20;

export function sanitizeCode(raw) {
  return typeof raw === 'string' ? raw.trim() : '';
}

export function validateCode(code) {
  if (!code) return '区域编号不能为空';
  if (code.length > MAX_CODE_LENGTH) return `编号长度不能超过 ${MAX_CODE_LENGTH} 个字符`;
  if (/[\r\n\t]/.test(code)) return '编号不能包含换行或制表符';
  if (code.includes('/') || code.includes('\\')) {
    return '编号不能包含 / 或 \\ 等路径字符';
  }
  return null;
}

export function validateRisk(risk) {
  return RISK_LEVELS.includes(risk) ? null : `风险等级必须是 ${RISK_LEVELS.join('/')}`;
}

/**
 * 新建区域的完整校验：字段、几何合法性、越界、自交、与现有区域重叠。
 * @returns {{ok:true, points:Array} | {ok:false, status:number, reason:string, detail:string}}
 */
export function checkNewRegion({ code, risk, points: rawPoints, width, height, others }) {
  const codeErr = validateCode(code);
  if (codeErr) return { ok: false, status: 400, reason: 'invalid_code', detail: codeErr };
  const riskErr = validateRisk(risk);
  if (riskErr) return { ok: false, status: 400, reason: 'invalid_risk', detail: riskErr };
  if (others.some((r) => r.code === code)) {
    return {
      ok: false,
      status: 409,
      reason: 'duplicate_code',
      detail: `编号「${code}」已被占用，请使用其它编号`,
    };
  }
  return checkGeometry(rawPoints, width, height, others);
}

/**
 * 更新区域的完整校验（乐观锁 + 几何 + 编号）。
 * @param others 当前所有「其它」未删除区域
 */
export function checkUpdateRegion({ code, risk, points: rawPoints, width, height, others, region }) {
  if (!region || region.deleted === 1) {
    return {
      ok: false,
      status: 409,
      reason: 'version_conflict',
      detail: '该区域已被删除，旧版本的修改无法恢复或覆盖它',
    };
  }
  const codeErr = validateCode(code);
  if (codeErr) return { ok: false, status: 400, reason: 'invalid_code', detail: codeErr };
  const riskErr = validateRisk(risk);
  if (riskErr) return { ok: false, status: 400, reason: 'invalid_risk', detail: riskErr };
  if (others.some((r) => r.code === code && r.id !== region.id)) {
    return {
      ok: false,
      status: 409,
      reason: 'duplicate_code',
      detail: `编号「${code}」已被其它区域占用`,
    };
  }
  return checkGeometry(rawPoints, width, height, others, region.id);
}

function checkGeometry(rawPoints, width, height, others, ignoreId = null) {
  const v = validatePoints(rawPoints, width, height);
  if (!v.ok) {
    return { ok: false, status: 400, reason: v.reason, detail: v.detail };
  }
  const points = v.points;
  for (const other of others) {
    if (ignoreId && other.id === ignoreId) continue;
    if (polygonsOverlap(points, other.points)) {
      return {
        ok: false,
        status: 409,
        reason: 'overlap',
        detail: `与已有区域「${other.code}」的区域内部重叠（仅允许共用边界），请调整顶点`,
      };
    }
  }
  return { ok: true, points };
}

/* ------------------------------------------------------------------ */
/* 整图 JSON 校验                                                       */
/* ------------------------------------------------------------------ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 解析并校验导出文件。严格校验，任一错误都整体拒绝（不返回部分结果）。
 * @param {object} data JSON.parse 后的对象
 * @param {Buffer} [embeddedImage] 单图导出可直接携带 base64；多图格式由调用方处理
 */
export function validateExportDocument(data) {
  if (!data || typeof data !== 'object') {
    throw exportError('文档根节点必须是对象');
  }
  if (data.format !== 'floorplan-annotator/v1') {
    throw exportError('缺少 format 字段或格式版本不受支持（应为 floorplan-annotator/v1）');
  }
  if (!Array.isArray(data.maps)) {
    throw exportError('maps 必须是数组（单图导出也需包裹为 maps:[...]）');
  }
  if (data.maps.length === 0) throw exportError('maps 为空，没有可导入的图');
  if (data.maps.length > MAX_SNAPSHOT_MAPS) {
    throw exportError(`一次最多导入 ${MAX_SNAPSHOT_MAPS} 张图`);
  }

  const seenIds = new Set();
  const maps = data.maps.map((m, i) => validateMapEntry(m, i, seenIds));
  return { format: data.format, exportedAt: typeof data.exportedAt === 'number' ? data.exportedAt : null, maps };
}

function validateMapEntry(m, index, seenIds) {
  const where = `maps[${index}]`;
  if (!m || typeof m !== 'object') throw exportError(`${where} 不是对象`);

  const meta = m.meta;
  if (!meta || typeof meta !== 'object') throw exportError(`${where}.meta 缺失`);
  if (typeof meta.id !== 'string' || !UUID_RE.test(meta.id)) {
    throw exportError(`${where}.meta.id 必须是 UUID`);
  }
  if (seenIds.has(meta.id)) throw exportError(`${where} 的图 ID 与其它图重复`);
  seenIds.add(meta.id);

  const name = meta.name;
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_LENGTH) {
    throw exportError(`${where}.meta.name 必须是 1-${MAX_NAME_LENGTH} 字符的字符串`);
  }
  for (const key of ['width', 'height', 'version']) {
    if (!Number.isInteger(meta[key]) || meta[key] <= 0) {
      throw exportError(`${where}.meta.${key} 必须是正整数`);
    }
  }
  if (meta.width > 50000 || meta.height > 50000) {
    throw exportError(`${where} 图片尺寸超出上限`);
  }
  if (!SUPPORTED.has(meta.mime_type)) {
    throw exportError(`${where}.meta.mime_type 只支持 image/png 或 image/jpeg`);
  }

  let image;
  if (typeof m.imageBase64 === 'string') {
    image = decodeBase64Strict(m.imageBase64, where);
  } else if (Buffer.isBuffer(m.image)) {
    image = m.image;
  } else {
    throw exportError(`${where} 缺少 imageBase64 图片数据`);
  }

  if (!Array.isArray(m.regions)) throw exportError(`${where}.regions 必须是数组`);
  if (m.regions.length > 5000) throw exportError(`${where} 区域数量超过 5000`);

  const regions = [];
  const codes = new Set();
  const regionIds = new Set();
  for (let i = 0; i < m.regions.length; i++) {
    const r = m.regions[i];
    const rWhere = `${where}.regions[${i}]`;
    if (!r || typeof r !== 'object') throw exportError(`${rWhere} 不是对象`);
    if (typeof r.id !== 'string' || !UUID_RE.test(r.id)) {
      throw exportError(`${rWhere}.id 必须是 UUID`);
    }
    if (regionIds.has(r.id)) throw exportError(`${rWhere} ID 与同图其它区域重复`);
    regionIds.add(r.id);

    const code = sanitizeCode(r.code);
    const codeErr = validateCode(code);
    if (codeErr) throw exportError(`${rWhere}：${codeErr}`);
    if (codes.has(code)) throw exportError(`${rWhere}：编号「${code}」在同图内重复`);
    codes.add(code);

    if (!RISK_LEVELS.includes(r.risk)) throw exportError(`${rWhere}.risk 非法`);
    if (!Number.isInteger(r.version) || r.version < 1) {
      throw exportError(`${rWhere}.version 必须是 >=1 的整数`);
    }
    for (const key of ['createdAt', 'updatedAt']) {
      if (!Number.isInteger(r[key]) || r[key] < 0) throw exportError(`${rWhere}.${key} 必须是非负整数`);
    }

    const geo = validatePoints(r.points, meta.width, meta.height);
    if (!geo.ok) throw exportError(`${rWhere}（编号 ${code}）${geo.detail}`);
    regions.push({
      id: r.id,
      code,
      risk: r.risk,
      points: geo.points,
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  }

  // 两两不重叠
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      if (polygonsOverlap(regions[i].points, regions[j].points)) {
        throw exportError(
          `${where}：区域「${regions[i].code}」与「${regions[j].code}」内部重叠，导入数据自相矛盾`
        );
      }
    }
    if (polygonArea(regions[i].points) < 1e-9) {
      throw exportError(`${where}：区域「${regions[i].code}」面积为 0`);
    }
  }

  return {
    meta: {
      id: meta.id,
      name: name.trim(),
      width: meta.width,
      height: meta.height,
      mime_type: meta.mime_type,
      version: meta.version,
      created_at: isInt(meta.created_at) ? meta.created_at : meta.createdAt ?? Date.now(),
      updated_at: isInt(meta.updated_at) ? meta.updated_at : meta.updatedAt ?? Date.now(),
    },
    image,
    regions,
  };
}

const SUPPORTED = new Set(['image/png', 'image/jpeg']);

function isInt(v) {
  return Number.isInteger(v) && v > 0;
}

function decodeBase64Strict(s, where) {
  if (!/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(s) || s.length === 0) {
    throw exportError(`${where} 的 imageBase64 不是合法 base64`);
  }
  const buf = Buffer.from(s, 'base64');
  if (buf.length === 0) throw exportError(`${where} 图片数据为空`);
  return buf;
}

export function exportError(message) {
  const err = new Error(message);
  err.name = 'ExportValidationError';
  return err;
}
