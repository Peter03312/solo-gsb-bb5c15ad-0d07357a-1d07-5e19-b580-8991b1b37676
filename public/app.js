/**
 * public/app.js — 展馆平面图标注前端（无框架，原生 SVG + ES Module）
 */
import {
  validatePoints, polygonsOverlap, polygonCentroid, pointsToSvg,
} from '/shared/geometry.js';

/* ---------------- 常量与状态 ---------------- */

const RISK = {
  low:    { label: '低风险', fill: 'rgba(22,163,74,.22)',  stroke: '#16a34a', text: '#14532d' },
  medium: { label: '中风险', fill: 'rgba(217,119,6,.22)',  stroke: '#d97706', text: '#78350f' },
  high:   { label: '高风险', fill: 'rgba(220,38,38,.24)',  stroke: '#dc2626', text: '#7f1d1d' },
};
const RISK_ORDER = ['low', 'medium', 'high'];
const DRAFT_KEY = (mapId) => `floorplan.draft.${mapId}`;

const state = {
  maps: [],
  current: null,              // {id,name,width,height,version,regions}
  view: { scale: 1, tx: 0, ty: 0 },
  tool: 'pan',                // pan | draw
  draft: null,                // {mode:'create'|'edit', points, code, risk, regionId?, expectedVersion?}
  selectedId: null,
  remoteVersionAtEdit: null,  // 编辑期间服务器版本变化提示
  remoteDeleted: false,       // 正在编辑的区域已被他人删除
  hoverImg: null,             // 鼠标对应原图坐标
  pointer: null,              // 拖拽状态
  evtSource: null,
  refreshTimer: null,
};

const $ = (id) => document.getElementById(id);
const svg = $('svg');
const viewport = $('viewport');
const regionsLayer = $('regionsLayer');
const draftLayer = $('draftLayer');
const overlayLayer = $('overlayLayer');
const mapImage = $('mapImage');
const gridRect = $('gridRect');
const NS = 'http://www.w3.org/2000/svg';

/* ---------------- HTTP ---------------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body instanceof FormData ? {} : { 'content-type': 'application/json' },
    ...options,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok) {
    const err = new Error(data?.detail || data?.error || `请求失败 (${res.status})`);
    err.status = res.status;
    err.reason = data?.error;
    err.detail = data?.detail;
    throw err;
  }
  return data;
}

function toast(kind, title, detail = '', ms = 4200) {
  const host = $('toastHost');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="t-title"></div><div class="t-detail"></div>`;
  el.querySelector('.t-title').textContent = title;
  el.querySelector('.t-detail').textContent = detail;
  host.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, ms);
  setTimeout(() => el.remove(), ms + 400);
}

/* ---------------- 地图加载 ---------------- */

async function loadMaps(selectId = null) {
  const data = await api('/api/maps');
  state.maps = data.maps;
  renderMapList();
  renderTabs();
  const want = selectId || state.current?.id || state.maps[0]?.id;
  if (want && state.maps.some((m) => m.id === want) && state.current?.id !== want) {
    await openMap(want);
  } else if (!want) {
    state.current = null;
    renderAll();
  }
}

async function openMap(id) {
  closeEventSource();
  const data = await api(`/api/maps/${id}`);
  state.current = data.map;
  state.selectedId = null;
  state.remoteVersionAtEdit = null;
  state.remoteDeleted = false;
  state.draft = loadDraft(id);
  $('emptyHint').classList.add('hidden');
  setupImage();
  fitView();
  connectEvents(id);
  renderAll();
}

function setupImage() {
  const m = state.current;
  mapImage.setAttribute('href', `/api/maps/${m.id}/image?v=${m.version}`);
  mapImage.setAttribute('width', m.width);
  mapImage.setAttribute('height', m.height);
  gridRect.setAttribute('x', 0);
  gridRect.setAttribute('y', 0);
  gridRect.setAttribute('width', m.width);
  gridRect.setAttribute('height', m.height);
  svg.setAttribute('viewBox', `0 0 ${m.width} ${m.height}`);
}

async function refreshMap(reason = '') {
  if (!state.current) return;
  let incoming;
  try {
    const data = await api(`/api/maps/${state.current.id}`);
    incoming = data.map;
  } catch (err) {
    if (err.status === 404) {
      toast('warn', '这张图已被他人删除', '正在返回图列表…', 6000);
      closeEventSource();
      state.current = null;
      await loadMaps();
    }
    return;
  }
  const draft = state.draft;

  // 正在编辑已有区域：检测该区域的服务器版本变化或删除
  if (draft?.mode === 'edit' && draft.regionId) {
    const before = state.current.regions.find((r) => r.id === draft.regionId);
    const after = incoming.regions.find((r) => r.id === draft.regionId);
    if (!after) {
      state.remoteDeleted = true;
      toast('warn', '区域已被他人删除',
        '你对该区域的未提交编辑仍保留在画布上，但无法覆盖保存回原区域；可另存为新区域。', 8000);
    } else if (before && after.version !== before.version && after.version !== draft.expectedVersion) {
      state.remoteVersionAtEdit = after;
    }
  }

  state.current.regions = incoming.regions;
  state.current.version = incoming.version;
  renderRegions();
  preserveInspectorFocus(() => renderInspector());
  renderStatus();
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => refreshMap('sse').catch(() => {}), 120);
}

/* ---------------- SSE 实时协作 ---------------- */

function connectEvents(mapId) {
  const es = new EventSource(`/api/maps/${mapId}/events?after=0`);
  state.evtSource = es;
  es.addEventListener('change', () => scheduleRefresh());
  es.onopen = () => { $('statusConn').className = 'conn on'; $('statusConn').title = '实时连接正常'; };
  es.onerror = () => { $('statusConn').className = 'conn off'; $('statusConn').title = '连接断开，正在重连'; };
}
function closeEventSource() {
  state.evtSource?.close();
  state.evtSource = null;
}

/* ---------------- 坐标换算 ---------------- */

function clientToImage(clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  const x = (clientX - rect.left - state.view.tx) / state.view.scale;
  const y = (clientY - rect.top - state.view.ty) / state.view.scale;
  return clampToImage({ x, y });
}

function clampToImage(p) {
  const m = state.current;
  return {
    x: Math.min(m.width, Math.max(0, p.x)),
    y: Math.min(m.height, Math.max(0, p.y)),
  };
}

function applyViewport() {
  const { scale, tx, ty } = state.view;
  viewport.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`);
  renderStatus();
}

/* ---------------- 缩放 / 平移 ---------------- */

function fitView() {
  if (!state.current) return;
  const rect = svg.getBoundingClientRect();
  const pad = 32;
  const s = Math.min(
    (rect.width - pad * 2) / state.current.width,
    (rect.height - pad * 2) / state.current.height,
    1
  );
  state.view.scale = s;
  state.view.tx = (rect.width - state.current.width * s) / 2;
  state.view.ty = (rect.height - state.current.height * s) / 2;
  applyViewport();
}

function zoomAt(clientX, clientY, factor) {
  if (!state.current) return;
  const rect = svg.getBoundingClientRect();
  const cx = clientX - rect.left;
  const cy = clientY - rect.top;
  const old = state.view.scale;
  const next = Math.min(20, Math.max(0.02, old * factor));
  // 以光标为不动点
  state.view.tx = cx - ((cx - state.view.tx) / old) * next;
  state.view.ty = cy - ((cy - state.view.ty) / old) * next;
  state.view.scale = next;
  applyViewport();
}

/* ---------------- 渲染 ---------------- */

function renderAll() {
  const has = !!state.current;
  $('emptyHint').classList.toggle('hidden', has);
  $('exportBtn').disabled = !has;
  $('deleteMapBtn').disabled = !has;
  renderMapList();
  renderTabs();
  setupImageView();
  renderRegions();
  renderDraft();
  renderInspector();
  renderStatus();
}

function setupImageView() {
  if (!state.current) {
    mapImage.setAttribute('href', '');
    return;
  }
  const m = state.current;
  const src = `/api/maps/${m.id}/image?v=${m.version}`;
  if (mapImage.getAttribute('href') !== src) setupImage();
  applyViewport();
}

function renderMapList() {
  const ul = $('mapList');
  ul.innerHTML = '';
  for (const m of state.maps) {
    const li = document.createElement('li');
    li.className = m.id === state.current?.id ? 'active' : '';
    li.innerHTML = `<div class="map-name"></div><div class="map-meta"></div>`;
    li.querySelector('.map-name').textContent = m.name;
    li.querySelector('.map-meta').textContent =
      `${m.width} × ${m.height}px · ${m.region_count ?? 0} 区域 · v${m.version}`;
    li.onclick = () => openMap(m.id);
    ul.appendChild(li);
  }
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.innerHTML = '';
  for (const m of state.maps) {
    const t = document.createElement('div');
    t.className = 'tab' + (m.id === state.current?.id ? ' active' : '');
    t.textContent = m.name;
    t.onclick = () => openMap(m.id);
    tabs.appendChild(t);
  }
}

function renderRegions() {
  regionsLayer.innerHTML = '';
  overlayLayer.innerHTML = '';
  if (!state.current) return;

  for (const r of state.current.regions) {
    const editing = state.draft?.mode === 'edit' && state.draft.regionId === r.id;
    if (editing) continue; // 编辑中的区域由 draft 层渲染
    const color = RISK[r.risk] || RISK.low;
    const poly = document.createElementNS(NS, 'polygon');
    poly.setAttribute('points', pointsToSvg(r.points));
    poly.setAttribute('class', 'region' + (r.id === state.selectedId ? ' selected' : ''));
    poly.setAttribute('fill', color.fill);
    poly.setAttribute('stroke', color.stroke);
    poly.dataset.regionId = r.id;
    regionsLayer.appendChild(poly);

    const c = polygonCentroid(r.points);
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'label-layer');
    g.setAttribute('transform', `translate(${c.x} ${c.y}) scale(${1 / state.view.scale})`);
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('class', 'region-label');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dy', '-2');
    text.setAttribute('fill', color.text);
    text.textContent = r.code;
    const sub = document.createElementNS(NS, 'text');
    sub.setAttribute('class', 'region-label');
    sub.setAttribute('text-anchor', 'middle');
    sub.setAttribute('dy', '13');
    sub.setAttribute('fill', color.text);
    sub.style.fontSize = '10px';
    sub.textContent = RISK[r.risk].label + ` v${r.version}`;
    g.append(text, sub);
    overlayLayer.appendChild(g);
  }
}

function renderDraft() {
  draftLayer.innerHTML = '';
  const d = state.draft;
  if (!state.current || !d) return;

  const editingExisting = d.mode === 'edit';
  const color = RISK[d.risk] || RISK.medium;
  if (d.points.length >= 2) {
    const fill = document.createElementNS(NS, 'polygon');
    fill.setAttribute('class', 'draft-fill');
    const closed = d.points.length >= 3 ? [...d.points, d.points[0]] : d.points;
    fill.setAttribute('points', pointsToSvg(closed));
    draftLayer.appendChild(fill);
  }

  // 编辑态：>=3 顶点时显示与风险色一致的闭合轮廓
  if (editingExisting && d.points.length >= 3) {
    const outline = document.createElementNS(NS, 'polygon');
    outline.setAttribute('points', pointsToSvg([...d.points, d.points[0]]));
    outline.setAttribute('fill', color.fill);
    outline.setAttribute('stroke', color.stroke);
    outline.setAttribute('stroke-width', 2.5);
    outline.setAttribute('vector-effect', 'non-scaling-stroke');
    draftLayer.appendChild(outline);
  }

  const linePts = d.points.slice();
  if (state.tool === 'draw' && state.hoverImg && !editingExisting) {
    linePts.push(state.hoverImg);
  }
  if (linePts.length >= 2) {
    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('class', 'draft');
    line.setAttribute('points', pointsToSvg(linePts));
    draftLayer.appendChild(line);
  }

  // 闭合橡皮筋：create 模式从悬停点回到首点
  if (d.mode === 'create' && state.tool === 'draw' && state.hoverImg && d.points.length >= 2) {
    const closeLine = document.createElementNS(NS, 'line');
    closeLine.setAttribute('x1', state.hoverImg.x);
    closeLine.setAttribute('y1', state.hoverImg.y);
    closeLine.setAttribute('x2', d.points[0].x);
    closeLine.setAttribute('y2', d.points[0].y);
    closeLine.setAttribute('stroke-dasharray', '3 4');
    closeLine.setAttribute('stroke', 'rgba(37,99,235,.5)');
    closeLine.setAttribute('stroke-width', 2);
    closeLine.setAttribute('vector-effect', 'non-scaling-stroke');
    draftLayer.appendChild(closeLine);
  }

  // 顶点
  d.points.forEach((p, i) => {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('transform', `translate(${p.x} ${p.y}) scale(${1 / state.view.scale})`);
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('r', editingExisting ? 5.5 : 4.5);
    c.setAttribute('class', 'handle');
    c.dataset.vertexIndex = String(i);
    g.appendChild(c);
    draftLayer.appendChild(g);
  });

  // 首点绿色闭合按钮（create，>=3 顶点且悬停在首点附近）
  if (d.mode === 'create' && d.points.length >= 3 && state.tool === 'draw' && state.hoverImg) {
    const first = d.points[0];
    const near = distImg(first, state.hoverImg) * state.view.scale < 12;
    if (near) {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('transform', `translate(${first.x} ${first.y}) scale(${1 / state.view.scale})`);
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('r', 7);
      c.setAttribute('class', 'closer');
      c.dataset.closeDraft = '1';
      g.appendChild(c);
      draftLayer.appendChild(g);
    }
  }
}

function renderStatus() {
  if (!state.current) {
    $('statusCoords').textContent = '原图坐标：—';
    $('statusZoom').textContent = '缩放：—';
    $('statusVersion').textContent = '';
    return;
  }
  if (state.hoverImg) {
    $('statusCoords').textContent = `原图坐标：(${Math.round(state.hoverImg.x)}, ${Math.round(state.hoverImg.y)})`;
  }
  $('statusZoom').textContent = `缩放：${Math.round(state.view.scale * 100)}%`;
  $('statusVersion').textContent = `图版本 v${state.current.version}`;
}

/* ---------------- 属性面板 ---------------- */

function renderInspector() {
  const sec = $('inspector');
  const body = $('inspectorBody');
  if (!state.current) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');

  const d = state.draft;
  if (d) {
    const isCreate = d.mode === 'create';
    const geo = validatePoints(d.points, state.current.width, state.current.height);
    const overlapErr = geo.ok ? firstOverlap(d) : null;
    const canSubmit =
      geo.ok && d.code.trim() && RISK_ORDER.includes(d.risk) && !overlapErr;

    let banner = '';
    if (state.remoteDeleted && d.mode === 'edit') {
      banner = `<div class="conflict-banner">⚠ 该区域已被<strong>他人删除</strong>，旧版本提交无法恢复原区域。
        你可以「另存为新区域」保留绘制内容。</div>`;
    } else if (state.remoteVersionAtEdit && d.mode === 'edit') {
      const rv = state.remoteVersionAtEdit;
      banner = `<div class="conflict-banner">⚠ 他人已将该区域改到 <span class="ver-badge">v${rv.version}</span>
        （编号 ${escapeHtml(rv.code)}，${RISK[rv.risk].label}）。你的未提交编辑仍保留：
        <div class="region-actions">
          <button class="btn small" id="btnOverwrite">用我的编辑提交为最新版</button>
          <button class="btn small" id="btnDiscard">放弃，用对方版本</button>
        </div></div>`;
    }

    body.innerHTML = `
      ${banner}
      <div class="field">
        <label>状态</label>
        <div class="meta-line">${isCreate ? '🆕 新建未保存区域' : `✏️ 编辑区域（基于 v${d.expectedVersion}）`} · ${d.points.length} 个顶点</div>
      </div>
      <div class="field">
        <label>唯一编号 *</label>
        <input id="fCode" type="text" maxlength="64" placeholder="例如 A-101" />
      </div>
      <div class="field">
        <label>风险等级 *</label>
        <select id="fRisk">
          ${RISK_ORDER.map((k) => `<option value="${k}">${RISK[k].label}</option>`).join('')}
        </select>
      </div>
      <div class="field draft-meta" id="geoMsg"></div>
      <div class="region-actions">
        <button class="btn primary small" id="btnSubmit" ${canSubmit ? '' : 'disabled'}>
          ${isCreate ? '创建区域' : '保存修改'}
        </button>
        ${state.remoteDeleted && !isCreate ? '<button class="btn small" id="btnSaveAs">另存为新区域</button>' : ''}
        <button class="btn small" id="btnCancel">取消</button>
      </div>`;

    const codeInput = $('fCode');
    codeInput.value = d.code;
    $('fRisk').value = d.risk;
    codeInput.oninput = () => { d.code = codeInput.value; persistDraft(); refreshSubmitState(); };
    $('fRisk').onchange = (e) => { d.risk = e.target.value; renderDraft(); persistDraft(); refreshSubmitState(); };
    $('btnSubmit').onclick = submitDraft;
    $('btnCancel').onclick = cancelDraft;
    $('btnSaveAs')?.addEventListener('click', saveEditAsNew);
    $('btnOverwrite')?.addEventListener('click', async () => {
      const rv = state.remoteVersionAtEdit;
      state.remoteVersionAtEdit = null;
      d.expectedVersion = rv.version;
      await submitDraft();
    });
    $('btnDiscard')?.addEventListener('click', () => {
      state.remoteVersionAtEdit = null;
      cancelDraft();
    });

    const msg = $('geoMsg');
    if (!geo.ok) {
      msg.innerHTML = `⛔ <span style="color:#991b1b">${escapeHtml(geo.detail)}</span>`;
    } else if (overlapErr) {
      msg.innerHTML = `⛔ <span style="color:#991b1b">${escapeHtml(overlapErr)}</span>`;
    } else {
      msg.innerHTML = `✅ 形状合法：${d.points.length} 顶点，未越界、无自交、不与已有区域重叠`;
    }
    return;
  }

  // 选中已有区域的只读面板
  const r = state.current.regions.find((x) => x.id === state.selectedId);
  if (!r) {
    body.innerHTML = `<p class="hint">在左侧选择图后，用 ✏️ 绘制工具在图上单击添加顶点；点击已有区域可查看与修改。</p>`;
    return;
  }
  body.innerHTML = `
    <div class="field">
      <label>唯一编号</label>
      <div class="meta-line" style="font-size:14px;color:var(--text);font-weight:600"></div>
    </div>
    <div class="field">
      <label>风险等级</label>
      <div class="meta-line" style="font-size:14px;color:var(--text)"></div>
    </div>
    <div class="field">
      <label>版本 / 顶点</label>
      <div class="meta-line"><span class="ver-badge">v${r.version}</span> · ${r.points.length} 个顶点（原图坐标）</div>
    </div>
    <div class="region-actions">
      <button class="btn primary small" id="btnEdit">编辑</button>
      <button class="btn danger small" id="btnDel">删除</button>
    </div>`;
  const lines = body.querySelectorAll('.meta-line');
  lines[0].textContent = r.code;
  lines[1].textContent = RISK[r.risk].label;
  $('btnEdit').onclick = () => startEdit(r);
  $('btnDel').onclick = () => deleteRegion(r);
}

function refreshSubmitState() {
  // 轻量刷新按钮可用态与几何提示，避免输入时整面板重建导致焦点丢失
  const d = state.draft;
  if (!d || !state.current) return;
  const geo = validatePoints(d.points, state.current.width, state.current.height);
  const overlapErr = geo.ok ? firstOverlap(d) : null;
  const btn = $('btnSubmit');
  if (btn) btn.disabled = !(geo.ok && d.code.trim() && RISK_ORDER.includes(d.risk) && !overlapErr);
  const msg = $('geoMsg');
  if (msg) {
    if (!geo.ok) msg.innerHTML = `⛔ <span style="color:#991b1b">${escapeHtml(geo.detail)}</span>`;
    else if (overlapErr) msg.innerHTML = `⛔ <span style="color:#991b1b">${escapeHtml(overlapErr)}</span>`;
    else msg.textContent = `✅ 形状合法：${d.points.length} 顶点，未越界、无自交、不与已有区域重叠`;
  }
}

function firstOverlap(draft) {
  for (const r of state.current.regions) {
    if (draft.mode === 'edit' && r.id === draft.regionId) continue;
    if (polygonsOverlap(draft.points, r.points)) {
      return `与已有区域「${r.code}」内部重叠（仅允许共用边界）`;
    }
  }
  return null;
}

/* ---------------- 草稿（未提交编辑）管理 ---------------- */

function startCreate() {
  state.draft = { mode: 'create', points: [], code: '', risk: 'medium' };
  state.selectedId = null;
  setTool('draw');
  state.remoteDeleted = false;
  state.remoteVersionAtEdit = null;
  clearDraftStorage();
  renderAll();
}

function startEdit(region) {
  state.draft = {
    mode: 'edit',
    regionId: region.id,
    expectedVersion: region.version,
    points: region.points.map((p) => ({ ...p })),
    code: region.code,
    risk: region.risk,
  };
  state.selectedId = region.id;
  state.remoteDeleted = false;
  state.remoteVersionAtEdit = null;
  setTool('pan');
  persistDraft();
  renderAll();
}

function cancelDraft() {
  state.draft = null;
  state.remoteDeleted = false;
  state.remoteVersionAtEdit = null;
  clearDraftStorage();
  renderAll();
}

function saveEditAsNew() {
  const old = state.draft;
  state.draft = { mode: 'create', points: old.points.map((p) => ({ ...p })), code: old.code, risk: old.risk };
  state.remoteDeleted = false;
  persistDraft();
  renderAll();
}

function persistDraft() {
  if (!state.current || !state.draft) return;
  localStorage.setItem(DRAFT_KEY(state.current.id), JSON.stringify(state.draft));
}
function loadDraft(mapId) {
  try {
    const raw = localStorage.getItem(DRAFT_KEY(mapId));
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.points)) return null;
    // 编辑草稿需校验区域仍存在且版本连续
    if (d.mode === 'edit') {
      const fresh = state.current?.regions.find((r) => r.id === d.regionId);
      if (!fresh) {
        toast('warn', '恢复了未提交的编辑', '对应区域已被删除，已转为「另存为新区域」模式。', 8000);
        return { mode: 'create', points: d.points, code: d.code, risk: d.risk };
      }
      if (fresh.version !== d.expectedVersion) {
        state.remoteVersionAtEdit = fresh;
      }
    }
    return d;
  } catch { return null; }
}
function clearDraftStorage() {
  if (state.current) localStorage.removeItem(DRAFT_KEY(state.current.id));
}

/* ---------------- 提交 / 删除（乐观锁） ---------------- */

async function submitDraft() {
  const d = state.draft;
  if (!d || !state.current) return;
  const mapId = state.current.id;

  // 提交前再做一次完整本地校验，给出即时原因
  const geo = validatePoints(d.points, state.current.width, state.current.height);
  if (!geo.ok) return toast('error', '无法提交', geo.detail);
  if (!d.code.trim()) return toast('error', '无法提交', '区域编号不能为空');
  const overlap = firstOverlap(d);
  if (overlap) return toast('error', '无法提交', overlap);

  const payload = {
    code: d.code.trim(),
    risk: d.risk,
    points: d.points,
  };
  try {
    if (d.mode === 'create') {
      await api(`/api/maps/${mapId}/regions`, { method: 'POST', body: JSON.stringify(payload) });
      toast('success', '区域已创建', `编号「${payload.code}」`);
    } else {
      await api(`/api/maps/${mapId}/regions/${d.regionId}`, {
        method: 'PUT',
        body: JSON.stringify({ ...payload, expectedVersion: d.expectedVersion }),
      });
      toast('success', '修改已保存', `编号「${payload.code}」· 版本已推进到 v${d.expectedVersion + 1}`);
    }
    state.draft = null;
    state.remoteVersionAtEdit = null;
    state.remoteDeleted = false;
    clearDraftStorage();
    await refreshMap();
  } catch (err) {
    // 冲突时编辑内容原样保留在画布/面板中
    if (err.status === 409 && err.reason === 'version_conflict') {
      if (/删除/.test(err.message)) {
        state.remoteDeleted = true;
        toast('error', '提交被拒绝：区域已删除', err.message, 9000);
      } else {
        await refreshMap();
        const fresh = state.current.regions.find((r) => r.id === d.regionId);
        if (fresh) state.remoteVersionAtEdit = fresh;
        toast('warn', '版本冲突，编辑已保留', err.message, 9000);
      }
      renderInspector();
    } else {
      toast('error', friendlyRejectTitle(err), err.message, 8000);
    }
  }
}

function friendlyRejectTitle(err) {
  switch (err.reason) {
    case 'overlap': return '形状与已有区域重叠';
    case 'self_intersecting': return '多边形自交';
    case 'out_of_bounds': return '顶点越出原图';
    case 'duplicate_code': return '编号不唯一';
    case 'duplicate_point':
    case 'too_few_points':
    case 'zero_area': return '形状不合法';
    default: return '提交被拒绝';
  }
}

async function deleteRegion(r) {
  if (!confirm(`确认删除区域「${r.code}」吗？\n删除后其它设备基于旧版本的提交将无法恢复该区域。`)) return;
  try {
    await api(`/api/maps/${state.current.id}/regions/${r.id}?expectedVersion=${r.version}`, { method: 'DELETE' });
    if (state.selectedId === r.id) state.selectedId = null;
    toast('success', '区域已删除', r.code);
    await refreshMap();
  } catch (err) {
    if (err.status === 409) {
      toast('warn', '删除冲突', err.message, 9000);
      await refreshMap();
    } else {
      toast('error', '删除失败', err.message);
    }
  }
}

/* ---------------- 指针交互 ---------------- */

svg.addEventListener('contextmenu', (e) => e.preventDefault());

svg.addEventListener('pointerdown', (e) => {
  if (!state.current) return;
  svg.setPointerCapture(e.pointerId);
  const img = clientToImage(e.clientX, e.clientY);

  // 顶点拖拽（编辑草稿时）
  const vi = e.target.dataset?.vertexIndex;
  if (state.draft && vi !== undefined) {
    state.pointer = { kind: 'vertex', index: Number(vi), startImg: img, moved: false, button: e.button };
    return;
  }
  // 点击首点闭合
  if (e.target.dataset?.closeDraft) {
    tryCloseDraft();
    return;
  }

  if (e.button === 1) {
    // 中键始终平移
    state.pointer = { kind: 'pan', startX: e.clientX, startY: e.clientY, tx: state.view.tx, ty: state.view.ty };
    return;
  }

  if (state.tool === 'draw' && e.button === 0) {
    if (!state.draft || state.draft.mode !== 'create') startCreate();
    state.pointer = { kind: 'maybe-click', startImg: img, moved: false };
    return;
  }

  // pan 工具：点区域选中，点空白平移
  const regionId = e.target.dataset?.regionId;
  if (regionId) {
    state.selectedId = regionId;
    state.pointer = { kind: 'maybe-select', regionId, moved: false };
    renderRegions();
    renderInspector();
    return;
  }
  if (e.button === 0 || e.button === 2) {
    state.pointer = {
      kind: 'pan', startX: e.clientX, startY: e.clientY,
      tx: state.view.tx, ty: state.view.ty,
    };
  }
});

svg.addEventListener('pointermove', (e) => {
  if (!state.current) return;
  const img = clientToImage(e.clientX, e.clientY);
  state.hoverImg = img;
  const p = state.pointer;

  if (p?.kind === 'vertex') {
    state.draft.points[p.index] = img;
    p.moved = true;
    renderDraft();
    refreshSubmitState();
    return;
  }
  if (p?.kind === 'pan') {
    state.view.tx = p.tx + (e.clientX - p.startX);
    state.view.ty = p.ty + (e.clientY - p.startY);
    applyViewport();
    renderRegions();
    renderDraft();
    return;
  }
  if (p?.kind === 'maybe-click') {
    if (distImg(p.startImg, img) * state.view.scale > 6) p.moved = true;
  }
  if (p?.kind === 'maybe-select') {
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 0) p.moved = true;
  }
  if (state.tool === 'draw' && state.draft) renderDraft();
  renderStatus();
});

svg.addEventListener('pointerup', (e) => {
  if (!state.current) return;
  const p = state.pointer;
  state.pointer = null;

  if (p?.kind === 'vertex') {
    persistDraft();
    return;
  }
  if (p?.kind === 'maybe-click' && !p.moved && state.tool === 'draw' && e.button === 0) {
    addVertex(p.startImg);
    return;
  }
  if (p?.kind === 'maybe-select' && p.moved) {
    // 拖动落在区域上：当作平移，不触发选择跳转
  }
});

svg.addEventListener('dblclick', (e) => {
  if (state.tool === 'draw' && state.draft?.mode === 'create') {
    e.preventDefault();
    tryCloseDraft();
  }
});

svg.addEventListener('wheel', (e) => {
  if (!state.current) return;
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  zoomAt(e.clientX, e.clientY, factor);
  renderRegions();
  renderDraft();
}, { passive: false });

function addVertex(p) {
  const d = state.draft;
  if (!d) return;
  // 与上一点过近则忽略
  const last = d.points[d.points.length - 1];
  if (last && distImg(last, p) * state.view.scale < 6) return;
  // 点到首点足够近 => 闭合
  if (d.points.length >= 3 && distImg(d.points[0], p) * state.view.scale < 12) {
    return tryCloseDraft();
  }
  d.points.push({ x: round1(p.x), y: round1(p.y) });
  persistDraft();
  renderDraft();
  refreshSubmitState();
}

function tryCloseDraft() {
  const d = state.draft;
  if (!d || d.points.length < 3) {
    toast('warn', '顶点不足', `多边形至少需要 3 个顶点，当前 ${d?.points.length || 0} 个`);
    return;
  }
  // 双击会产生与末点重复的点
  const pts = d.points;
  if (distImg(pts[pts.length - 1], pts[pts.length - 2]) * state.view.scale < 6) {
    pts.pop();
  }
  const geo = validatePoints(pts, state.current.width, state.current.height);
  if (!geo.ok) {
    toast('error', '无法完成形状', geo.detail);
    renderDraft();
    return;
  }
  renderDraft();
  renderInspector();
  setTimeout(() => $('fCode')?.focus(), 0);
}

function distImg(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function round1(v) { return Math.round(v * 10) / 10; }

/* ---------------- 键盘快捷键 ---------------- */

window.addEventListener('keydown', (e) => {
  if (!state.current) return;
  const tag = document.activeElement?.tagName;
  const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';

  if (state.draft?.mode === 'create' && state.tool === 'draw') {
    if (e.key === 'Enter') { e.preventDefault(); tryCloseDraft(); return; }
    if (e.key === 'Escape') { cancelDraft(); return; }
    if ((e.key === 'Backspace' || e.key === 'z') && !typing) {
      e.preventDefault();
      state.draft.points.pop();
      persistDraft();
      renderDraft();
      refreshSubmitState();
      return;
    }
  } else if (e.key === 'Escape' && state.draft) {
    cancelDraft();
    return;
  }

  if (typing) return;
  if (e.key === 'v' || e.key === 'V') setTool('pan');
  if (e.key === 'p' || e.key === 'P') {
    if (!state.draft || state.draft.mode !== 'edit') {
      if (!state.draft) startCreate();
      else setTool('draw');
    }
  }
  if (e.key === 'f' || e.key === 'F') fitView();
  if (e.key === '1') zoomAtCenter(1 / state.view.scale);
  if (e.key === '+' || e.key === '=') zoomAtCenter(1.2);
  if (e.key === '-') zoomAtCenter(1 / 1.2);
});

function zoomAtCenter(factor) {
  const rect = svg.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  renderRegions();
  renderDraft();
}

/* ---------------- 工具切换 ---------------- */

function setTool(tool) {
  state.tool = tool;
  $('toolPan').classList.toggle('active', tool === 'pan');
  $('toolDraw').classList.toggle('active', tool === 'draw');
  svg.classList.toggle('drawing', tool === 'draw');
  $('drawHint').classList.toggle('hidden', !(tool === 'draw' && state.draft?.mode === 'create'));
}

$('toolPan').onclick = () => setTool('pan');
$('toolDraw').onclick = () => {
  if (!state.current) return toast('warn', '请先选择或上传一张图');
  if (!state.draft) startCreate();
  else setTool('draw');
};
$('btnZoomIn').onclick = () => zoomAtCenter(1.25);
$('btnZoomOut').onclick = () => zoomAtCenter(1 / 1.25);
$('btnFit').onclick = () => fitView();
$('btn100').onclick = () => zoomAtCenter(1 / state.view.scale);

/* ---------------- 上传 / 导入 / 导出 ---------------- */

$('uploadInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const fd = new FormData();
  fd.append('image', file, file.name);
  fd.append('name', file.name.replace(/\.[^.]+$/, ''));
  try {
    const data = await api('/api/maps', { method: 'POST', body: fd });
    toast('success', '上传成功', `${data.map.name}（${data.map.width}×${data.map.height}）`);
    await loadMaps(data.map.id);
  } catch (err) {
    toast('error', '图片未被接受', err.message, 9000);
  }
});

$('importBtn').onclick = () => $('importInput').click();
$('importInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 100 * 1024 * 1024) return toast('error', '文件过大', '导入 JSON 不能超过 100MB');
  try {
    const text = await file.text();
    let json;
    try { json = JSON.parse(text); }
    catch { return toast('error', '导入失败：JSON 无效', '文件不是合法 JSON，未做任何写入。', 9000); }
    const data = await api('/api/import', { method: 'POST', body: JSON.stringify(json) });
    const summary = data.imported.map((m) => `${m.name}（${m.regionCount} 区域，v${m.version}）`).join('；');
    toast('success', `已导入 ${data.imported.length} 张图`, summary, 8000);
    state.current = null;
    await loadMaps(data.imported[0]?.id);
  } catch (err) {
    toast('error', '导入被整体拒绝', err.message, 10000);
  }
});

$('exportBtn').onclick = async () => {
  if (!state.current) return;
  const res = await fetch(`/api/maps/${state.current.id}/export`);
  if (!res.ok) return toast('error', '导出失败', `HTTP ${res.status}`);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.current.name.replace(/[\\/:*?"<>|]/g, '_')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

$('deleteMapBtn').onclick = async () => {
  if (!state.current) return;
  const m = state.current;
  if (!confirm(`确认删除整张图「${m.name}」及其全部 ${m.regions.length} 个区域？此操作不可恢复。`)) return;
  try {
    await api(`/api/maps/${m.id}`, { method: 'DELETE' });
    closeEventSource();
    state.current = null;
    clearDraftStorage();
    toast('success', '图已删除', m.name);
    await loadMaps();
  } catch (err) {
    toast('error', '删除失败', err.message);
  }
};

/* ---------------- 工具函数 ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 远程刷新重建属性面板时，保留输入框焦点与光标位置 */
function preserveInspectorFocus(fn) {
  const el = document.activeElement;
  const restore =
    el && (el.id === 'fCode' || el.id === 'fRisk')
      ? { id: el.id, start: el.selectionStart, end: el.selectionEnd }
      : null;
  fn();
  if (restore) {
    const next = document.getElementById(restore.id);
    if (next) {
      next.focus();
      if (restore.start != null && typeof next.setSelectionRange === 'function') {
        const pos = Math.min(restore.start, next.value.length);
        next.setSelectionRange(pos, Math.min(restore.end, next.value.length));
      }
    }
  }
}

/* ---------------- 启动 ---------------- */

window.addEventListener('resize', () => {
  if (!state.current) return;
  fitView();
  renderRegions();
  renderDraft();
});
loadMaps().catch((err) => toast('error', '初始化失败', err.message));
