/**
 * shared/geometry.js
 * 多边形几何校验，服务端与浏览器端共用同一份实现。
 *
 * 坐标约定：所有顶点均为「原图像素坐标」，x 向右、y 向下，原点在图片左上角。
 *
 * 重叠判定语义：
 *   - 两个区域仅边界相接（共用一段墙、端点相接）=> 允许
 *   - 边真正交叉、一个区域的点/边中点落在另一区域内部、两多边形完全相同 => 判为重叠并拒绝
 */

export const MIN_POINTS = 3;

export function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 校验并规范化点序列。
 * @returns {{ok:true, points:Array<{x:number,y:number}>} | {ok:false, reason:string, detail?:string}}
 */
export function validatePoints(rawPoints, width, height) {
  if (!Array.isArray(rawPoints)) {
    return { ok: false, reason: 'points_not_array', detail: '顶点必须是数组' };
  }
  if (rawPoints.length < MIN_POINTS) {
    return {
      ok: false,
      reason: 'too_few_points',
      detail: `多边形至少需要 ${MIN_POINTS} 个顶点，当前 ${rawPoints.length} 个`,
    };
  }
  if (rawPoints.length > 2000) {
    return { ok: false, reason: 'too_many_points', detail: '单个多边形顶点数不能超过 2000' };
  }

  const points = [];
  for (let i = 0; i < rawPoints.length; i++) {
    const p = rawPoints[i];
    if (!p || !isFiniteNumber(p.x) || !isFiniteNumber(p.y)) {
      return { ok: false, reason: 'invalid_point', detail: `第 ${i + 1} 个顶点坐标无效（必须为有限数字）` };
    }
    points.push({ x: p.x, y: p.y });
  }

  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
    return { ok: false, reason: 'invalid_bounds', detail: '图片尺寸无效' };
  }

  for (let i = 0; i < points.length; i++) {
    const { x, y } = points[i];
    // 允许极小浮点误差贴边，超出 1e-6 像素即拒绝
    if (x < -1e-6 || y < -1e-6 || x > width + 1e-6 || y > height + 1e-6) {
      return {
        ok: false,
        reason: 'out_of_bounds',
        detail:
          `第 ${i + 1} 个顶点 (${fmt(x)}, ${fmt(y)}) 超出原图范围 ` +
          `(0, 0) – (${fmt(width)}, ${fmt(height)})`,
      };
    }
    points[i] = { x: clamp(x, 0, width), y: clamp(y, 0, height) };
  }

  // 相邻重复顶点（含首尾）会产生零长度边
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) {
      return {
        ok: false,
        reason: 'duplicate_point',
        detail: `第 ${i + 1} 个顶点与第 ${((i + 1) % n) + 1} 个顶点重合`,
      };
    }
  }

  const self = findSelfIntersection(points);
  if (self) {
    return {
      ok: false,
      reason: 'self_intersecting',
      detail:
        `多边形自交：第 ${self.a + 1} 条边与第 ${self.b + 1} 条边${self.kind === 'cross' ? '交叉' : '非正常相接'}。` +
        '请调整顶点，使边只在相邻端点处相连',
    };
  }

  if (polygonArea(points) < 1e-9) {
    return { ok: false, reason: 'zero_area', detail: '多边形面积为 0，所有顶点几乎共线' };
  }

  return { ok: true, points };
}

/**
 * 判断两个多边形是否在「内部」相交（仅边界相接不算）。
 * @returns {boolean}
 */
export function polygonsOverlap(a, b) {
  if (samePointSet(a, b)) return true;

  const na = a.length;
  const nb = b.length;

  for (let i = 0; i < na; i++) {
    const a1 = a[i];
    const a2 = a[(i + 1) % na];
    for (let j = 0; j < nb; j++) {
      const b1 = b[j];
      const b2 = b[(j + 1) % nb];
      if (properSegmentsCross(a1, a2, b1, b2)) return true;
    }
  }

  // 任一端点严格位于另一多边形内部 => 包含/重叠
  for (const p of a) if (pointInPolygon(p, b) === 'inside') return true;
  for (const p of b) if (pointInPolygon(p, a) === 'inside') return true;

  // 边中点严格位于另一多边形内部（捕捉“凹口跨接”等顶点都在边界上的情形）
  for (let i = 0; i < na; i++) {
    const m = midpoint(a[i], a[(i + 1) % na]);
    if (pointInPolygon(m, b) === 'inside') return true;
  }
  for (let j = 0; j < nb; j++) {
    const m = midpoint(b[j], b[(j + 1) % nb]);
    if (pointInPolygon(m, a) === 'inside') return true;
  }

  return false;
}

/* ------------------------------------------------------------------ */
/* 基础几何原语                                                        */
/* ------------------------------------------------------------------ */

function cross(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

function orient(a, b, c) {
  const v = cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
  if (v > 1e-10) return 1;
  if (v < -1e-10) return -1;
  return 0;
}

function pointOnSegment(p, a, b) {
  if (orient(a, b, p) !== 0) return false;
  return (
    Math.min(a.x, b.x) - 1e-10 <= p.x &&
    p.x <= Math.max(a.x, b.x) + 1e-10 &&
    Math.min(a.y, b.y) - 1e-10 <= p.y &&
    p.y <= Math.max(a.y, b.y) + 1e-10
  );
}

/** 两条边在内部真正交叉；端点恰好落在另一条边上不算 */
function properSegmentsCross(p1, p2, p3, p4) {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

/** 共线情况下两条边是否有长度为正的重叠 */
function collinearOverlap(a1, a2, b1, b2) {
  if (orient(a1, a2, b1) !== 0 || orient(a1, a2, b2) !== 0) return false;
  // 水平/竖直投影均可，这里按 x 投影，竖线退化时改用 y
  let pts;
  if (Math.abs(a1.x - a2.x) > 1e-12 || Math.abs(b1.x - b2.x) > 1e-12) {
    pts = [
      [a1.x, 1, 0], [a2.x, 1, 1],
      [b1.x, 0, 0], [b2.x, 0, 1],
    ].sort((p, q) => p[0] - q[0]);
  } else {
    pts = [
      [a1.y, 1, 0], [a2.y, 1, 1],
      [b1.y, 0, 0], [b2.y, 0, 1],
    ].sort((p, q) => p[0] - q[0]);
  }
  // 排序后中间两个点若属于不同边且不重合，则存在正长度重叠
  const mid1 = pts[1];
  const mid2 = pts[2];
  if (Math.abs(mid1[0] - mid2[0]) < 1e-10) return false;
  return mid1[1] !== mid2[1];
}

/**
 * 射线法点在多边形内判定。
 * @returns {'inside'|'outside'|'boundary'}
 */
export function pointInPolygon(p, poly) {
  const n = poly.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[j];
    const b = poly[i];
    if (pointOnSegment(p, a, b)) return 'boundary';
    const intersects =
      b.y > p.y !== a.y > p.y &&
      p.x < ((a.x - b.x) * (p.y - b.y)) / (a.y - b.y) + b.x;
    if (intersects) inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}

function findSelfIntersection(points) {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a1 = points[i];
    const a2 = points[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // 相邻边（含首尾）允许共享端点
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      const b1 = points[j];
      const b2 = points[(j + 1) % n];

      if (properSegmentsCross(a1, a2, b1, b2)) return { a: i, b: j, kind: 'cross' };
      if (collinearOverlap(a1, a2, b1, b2)) return { a: i, b: j, kind: 'overlap' };

      // 非相邻顶点落在另一条边内部 => 捏合点
      if (pointOnSegment(b1, a1, a2) && !samePoint(b1, a1) && !samePoint(b1, a2)) {
        return { a: i, b: j, kind: 'touch' };
      }
      if (pointOnSegment(b2, a1, a2) && !samePoint(b2, a1) && !samePoint(b2, a2)) {
        return { a: i, b: j, kind: 'touch' };
      }
      if (pointOnSegment(a1, b1, b2) && !samePoint(a1, b1) && !samePoint(a1, b2)) {
        return { a: i, b: j, kind: 'touch' };
      }
      if (pointOnSegment(a2, b1, b2) && !samePoint(a2, b1) && !samePoint(a2, b2)) {
        return { a: i, b: j, kind: 'touch' };
      }
    }
  }
  return null;
}

export function polygonArea(points) {
  let s = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

export function polygonCentroid(points) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    const f = p.x * q.y - q.x * p.y;
    a += f;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) {
    const avg = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    return { x: avg.x / points.length, y: avg.y / points.length };
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function pointsToSvg(points) {
  return points.map((p) => `${round(p.x)},${round(p.y)}`).join(' ');
}

function samePoint(a, b) {
  return Math.abs(a.x - b.x) < 1e-10 && Math.abs(a.y - b.y) < 1e-10;
}

function samePointSet(a, b) {
  if (a.length !== b.length) return false;
  const used = new Array(b.length).fill(false);
  for (const pa of a) {
    let found = false;
    for (let j = 0; j < b.length; j++) {
      if (!used[j] && samePoint(pa, b[j])) {
        used[j] = true;
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function fmt(v) {
  return String(Math.round(v * 100) / 100);
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
