'use strict';
/*
 * 几何校验单元测试：node tests/geometry.test.js
 * 覆盖：顶点/共线/自交/越界、边接触、共边、包含、穿插、凹多边形。
 */
const assert = require('node:assert/strict');
const g = require('../shared/geometry');

const img = { width: 300, height: 200 };
const A = [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }, { x: 10, y: 50 }];

let n = 0;
function check(name, fn) {
  fn();
  n++;
  console.log('  ✓', name);
}

check('合法三角形', () =>
  assert.equal(g.validateVertices([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], img), null));

check('合法凹多边形', () =>
  assert.equal(
    g.validateVertices([{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 60, y: 50 }, { x: 100, y: 90 }, { x: 10, y: 90 }], img),
    null));

check('顶点数不足被拒', () =>
  assert.match(g.validateVertices([{ x: 0, y: 0 }, { x: 10, y: 0 }], img), /3 个顶点/));

check('重复顶点被拒', () =>
  assert.match(g.validateVertices([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 10 }], img), /重复/));

check('全部共线被拒', () =>
  assert.match(g.validateVertices([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], img), /共线/));

check('蝴蝶结自交被拒（面积非零时也必须检出）', () =>
  assert.match(
    g.validateVertices([{ x: 20, y: 20 }, { x: 260, y: 30 }, { x: 40, y: 180 }, { x: 280, y: 170 }], img),
    /自交/));

check('对称蝴蝶结（面积恰好抵消）也被拒', () =>
  assert.match(
    g.validateVertices([{ x: 120, y: 120 }, { x: 260, y: 120 }, { x: 120, y: 180 }, { x: 260, y: 180 }], img),
    /自交|共线/));

check('五顶点自交被拒', () =>
  assert.match(
    g.validateVertices([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }, { x: 50, y: 50 }, { x: 100, y: 100 }], img),
    /自交/));

check('X/Y 越界被拒并说明坐标', () => {
  assert.match(g.validateVertices([{ x: 0, y: 0 }, { x: 301, y: 0 }, { x: 0, y: 10 }], img), /301.*越界/);
  assert.match(g.validateVertices([{ x: -1, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], img), /越界/);
  assert.match(g.validateVertices([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 201 }], img), /越界/);
});

check('恰好在图像边界（0 与 width/height）合法', () =>
  assert.equal(g.validateVertices([{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 0, y: 200 }], img), null));

check('非数字坐标被拒', () =>
  assert.match(g.validateVertices([{ x: 'a', y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], img), /无效/));

check('完全分离不重叠', () =>
  assert.equal(
    g.validateOverlap([{ id: 1, code: 'A', vertices: A }],
      [{ x: 60, y: 60 }, { x: 90, y: 60 }, { x: 90, y: 90 }, { x: 60, y: 90 }]),
    null));

check('共角相触判为重叠', () =>
  assert.match(
    g.validateOverlap([{ id: 1, code: 'A', vertices: A }],
      [{ x: 50, y: 50 }, { x: 80, y: 50 }, { x: 80, y: 80 }, { x: 50, y: 80 }]),
    /重叠|相触/));

check('共边判为重叠', () =>
  assert.match(
    g.validateOverlap([{ id: 1, code: 'A', vertices: A }],
      [{ x: 50, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 50 }, { x: 50, y: 50 }]),
    /重叠|相触/));

check('一个包含另一个判为重叠', () =>
  assert.match(
    g.validateOverlap(
      [{ id: 1, code: 'BIG', vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] }], A),
    /重叠|相触/));

check('条带穿插判为重叠', () =>
  assert.match(
    g.validateOverlap([{ id: 1, code: 'A', vertices: A }],
      [{ x: 0, y: 30 }, { x: 100, y: 30 }, { x: 100, y: 31 }, { x: 0, y: 31 }]),
    /重叠|相触/));

check('顶点落在对方边上判为重叠', () =>
  assert.match(
    g.validateOverlap([{ id: 1, code: 'A', vertices: A }],
      [{ x: 30, y: 50 }, { x: 60, y: 50 }, { x: 60, y: 70 }, { x: 30, y: 70 }]),
    /重叠|相触/));

console.log(`\n几何测试通过：${n} 项`);
