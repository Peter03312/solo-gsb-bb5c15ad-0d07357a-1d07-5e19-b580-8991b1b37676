'use strict';
/*
 * 多边形几何校验（服务端 Node 与浏览器端共用，UMD 风格）。
 * 所有坐标均指「原图像素坐标」，原点在左上角，x 向右、y 向下。
 */

/** 叉积 (b-a) x (c-a) */
function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** 多边形有向面积（两倍），同时也用于判断退化形状 */
function signedArea2(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

/**
 * 严格的线段相交判定：端点相接、T 型接触、部分重叠均视为相交。
 * 相邻边共享端点不算相交（由调用方跳过）。
 */
function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = cross(p3, p4, p1); // p1 相对 p3->p4
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);

  const strict = (a, b) => (a > 0 && b < 0) || (a < 0 && b > 0);
  if (strict(d1, d2) && strict(d3, d4)) return true;

  // 端点落在另一线段上（含共线重叠）
  const onSeg = (p, a, b) =>
    cross(a, b, p) === 0 &&
    Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y);

  return onSeg(p1, p3, p4) || onSeg(p2, p3, p4) ||
         onSeg(p3, p1, p2) || onSeg(p4, p1, p2);
}

/** 自交检查：非相邻边出现任何相交（含顶点触碰/重叠）即为自交 */
function isSelfIntersecting(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const e1a = poly[i];
    const e1b = poly[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // 相邻边（含首尾边）共享端点，跳过
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      const e2a = poly[j];
      const e2b = poly[(j + 1) % n];
      if (segmentsIntersect(e1a, e1b, e2a, e2b)) return true;
    }
  }
  return false;
}

/** 点在多边形内（含边界），射线法 */
function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (((a.y > p.y) !== (b.y > p.y)) &&
        (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)) {
      inside = !inside;
    }
  }
  return inside;
}

/** 两个多边形是否有面积重叠，或边界在任意位置接触/交叉 */
function polygonsOverlap(a, b) {
  // 1) 任意边相交（含端点接触、共线）
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(a1, a2, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  // 2) 完全包含：任一顶点落入对方内部
  return pointInPolygon(a[0], b) || pointInPolygon(b[0], a);
}

/**
 * 校验一组顶点本身是否合法。
 * 返回 null 表示通过；否则返回中文原因。
 * @param {Array<{x:number,y:number}>} vertices
 * @param {{width:number,height:number}} image
 */
function validateVertices(vertices, image) {
  if (!Array.isArray(vertices) || vertices.length < 3) {
    return '区域至少需要 3 个顶点';
  }
  if (vertices.length > 1000) {
    return '区域顶点数不能超过 1000';
  }
  const seen = new Set();
  for (let i = 0; i < vertices.length; i++) {
    const p = vertices[i];
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' ||
        !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return `第 ${i + 1} 个顶点坐标无效（必须为有限数字）`;
    }
    if (p.x < 0 || p.y < 0 || p.x > image.width || p.y > image.height) {
      return `第 ${i + 1} 个顶点 (${fmt(p.x)}, ${fmt(p.y)}) 越界：超出原图范围 (0–${image.width}, 0–${image.height})`;
    }
    const key = p.x.toFixed(3) + ',' + p.y.toFixed(3);
    if (seen.has(key)) {
      return `第 ${i + 1} 个顶点与前面的顶点重复，不能形成有效多边形`;
    }
    seen.add(key);
  }
  if (signedArea2(vertices) === 0) {
    return '所有顶点共线，区域面积为零，不是有效的多边形';
  }
  if (isSelfIntersecting(vertices)) {
    return '多边形存在自交（非相邻边交叉或顶点触碰），请调整顶点顺序后再提交';
  }
  return null;
}

function fmt(n) {
  return Math.round(n * 100) / 100;
}

/**
 * 校验与同一图上其他已有区域是否重叠。
 * @param {Array} others 已有区域，结构 {id, code, vertices:[{x,y}]}
 * @param {Array} vertices 待保存区域
 */
function validateOverlap(others, vertices) {
  for (const o of others) {
    let ov;
    try {
      ov = polygonsOverlap(vertices, o.vertices);
    } catch (_) {
      ov = false;
    }
    if (ov) {
      return `与已有区域「${o.code}」(id=${o.id}) 重叠或边界相触，区域之间必须完全分离`;
    }
  }
  return null;
}

const api = {
  cross,
  signedArea2,
  segmentsIntersect,
  isSelfIntersecting,
  pointInPolygon,
  polygonsOverlap,
  validateVertices,
  validateOverlap,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.Geometry = api;
}
