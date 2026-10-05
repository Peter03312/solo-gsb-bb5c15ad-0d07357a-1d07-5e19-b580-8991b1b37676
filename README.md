# 展馆平面图协作标注 Web 应用

在浏览器里上传展馆平面图（PNG/JPEG），多人同时在同一张图上缩放、平移、绘制多边形风险区域，
填写**唯一编号**与**风险等级**。所有顶点按**原图像素坐标**保存，换设备、刷新页面后位置完全一致。

- **后端**：Node.js（内置 `http`）+ SQLite（`better-sqlite3`，WAL 模式），无 Web 框架
- **前端**：原生 HTML/SVG/ES Module，无构建步骤、无第三方账号、无 CDN 依赖
- **实时协作**：SSE（Server-Sent Events）推送他人改动，自动合并到当前画布
- **并发控制**：每个区域带 `version`，提交必须带期望版本（乐观锁）；冲突时**保留未提交编辑**
- **数据安全**：图片损坏、导入 JSON 非法时整体拒绝；导入在单个事务中执行，失败自动回滚，不产生部分写入

---

## 一、Docker Compose 一键启动（推荐）

```bash
docker compose up -d --build
```

启动后访问：

> **http://localhost:8080**

数据持久化在 Docker 卷 `floorplan-data`（容器内 `/data/floorplan.db`），镜像重建不丢数据。

常用命令：

```bash
docker compose logs -f          # 查看日志
docker compose down             # 停止（保留数据卷）
docker compose down -v          # 停止并删除数据卷（清空所有图）
```

## 二、本地 Node.js 直接运行

要求 Node.js ≥ 20。

```bash
npm install        # better-sqlite3 无预编译包时会本地源码编译，需要 python3/make/g++
npm start
```

打开 http://localhost:8080 即可。首次启动会自动创建 `data/` 目录、SQLite 数据库与全部表结构（依赖初始化）。

## 三、配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 服务监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；本机自用可设 `127.0.0.1` |
| `DB_PATH` | `./data/floorplan.db` | SQLite 数据库文件路径，自动建库建表 |
| `MAX_UPLOAD_MB` | `100` | 单张图片 / 导入 JSON 大小上限（MB） |

Docker Compose 下通过项目根目录的 `.env` 覆盖（见 `.env.example`）：

```bash
cp .env.example .env
# APP_PORT=8080          # 宿主机映射端口
# MAX_UPLOAD_MB=100
docker compose up -d --build
```

例如改用 9090 端口：`APP_PORT=9090 docker compose up -d --build`，随后访问 http://localhost:9090 。

健康检查：

```bash
curl http://localhost:8080/api/health
# {"ok":true,"db":"floorplan.db"}
```

---

## 功能说明

### 绘制与标注

1. 右上角 **上传 PNG/JPEG**（服务端会解析真实尺寸并校验文件结构，损坏图片会被拒绝，不产生任何记录）。
2. 工具栏选择 **✏️ 绘制**（快捷键 `P`）：
   - 单击逐个添加顶点，双击或按 `Enter` 闭合（至少 3 个顶点）
   - `Backspace` 撤销上一个顶点，`Esc` 取消绘制
   - 闭合后在左侧面板填写**唯一编号**与**风险等级**（低 / 中 / 高），点击**创建区域**
3. **✋ 平移**（快捷键 `V`）：拖动平移；滚轮以光标为中心缩放；也可用 ＋/－、**适应**（`F`）、**1:1**
4. 点击已有区域可查看属性（编号、风险、版本、顶点数），点**编辑**可拖动顶点调整形状
5. 顶点始终是原图像素坐标，缩放/平移只改变视图，不影响存储

### 形状校验（前后端同一套规则）

提交时若不合法会明确拒绝并说明原因：

| 情形 | 拒绝原因（接口错误码） |
| --- | --- |
| 顶点少于 3 个、相邻顶点重合、面积为 0 | `too_few_points` / `duplicate_point` / `zero_area` |
| 非相邻边交叉、非相邻顶点压在别的边上、共线重叠 | **自交** `self_intersecting`，会指出是哪两条边 |
| 顶点落在原图范围外 | **越界** `out_of_bounds`，会指出顶点坐标与图尺寸 |
| 与已有区域内部相交 / 包含 / 完全重合 | **重叠** `overlap`，会指出冲突区域编号 |
| 编号为空、过长或同图重复 | `invalid_code` / `duplicate_code` |

> 边界相接是允许的：两个区域**共用一段墙（共享边）或只碰一个角点**不会被判重叠；
> 只要有一点点内部相交就拒绝。

### 并发与版本

- 每个区域有从 `v1` 开始的版本号，每次成功修改 `+1`；整张图也有版本号，任何区域变化都会推进。
- 保存/删除时必须带上自己所基于的版本（`expectedVersion`）：
  - **版本过期**（他人已改过）→ 返回 `409 version_conflict`。
    你的未提交编辑**不会丢失**：仍保留在画布和属性面板中，面板会提示对方的最新版本，
    可选择「用我的编辑提交为最新版」（基于对方版本再提交）或「放弃，用对方版本」。
  - **区域已被删除** → 旧版本的 PUT/DELETE 都返回 `409`，**无法恢复或复活该区域**；
    你的绘制内容仍保留，可用「另存为新区域」保留成果。
- 编号在同一张图的未删除区域中唯一（数据库唯一索引 + 事务内复查双重保证）。
- 未提交的草稿保存在浏览器 `localStorage`，刷新页面后仍可继续；若草稿对应的区域已被他人删除，会自动转为「另存为新区域」。

### 多人实时协作

- 打开同一张图的客户端通过 SSE 长连接接收变更（新建 / 修改 / 删除 / 导入），
  收到后增量拉取最新数据：他人的区域立即出现，你正在输入的表单焦点不会被打断。
- 断线自动重连（浏览器原生 EventSource）；即使不使用推送，冲突仍由服务端版本检查兜底。

### 整图 JSON 导出 / 导入

- 工具栏 **导出整图 JSON**：下载单个 `.json`，包含图 ID、名称、**原图尺寸与版本**、
  图片二进制（base64）以及每个区域的编号、风险、**原图坐标顶点**、**区域版本**与时间戳。
- 右上角 **导入 JSON**：按图 ID 对齐替换（库中其它图不受影响）。
  导入会完整重放所有校验：
  - JSON 语法/格式错误、字段缺失、版本不是正整数 → 整体拒绝
  - base64 图片损坏、实际尺寸与声明尺寸不符 → 整体拒绝
  - 顶点越界、多边形自交、导入数据内部区域互相重叠、编号重复 → 整体拒绝
  - **任何一项失败，事务回滚，数据库保持导入前状态，不会出现一半新一半旧的部分写入**
- 导出再导入是幂等往返：图片字节、尺寸、区域顶点、区域版本与图版本均保持不变。

---

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/maps` | 图列表 |
| `POST` | `/api/maps` | 上传图片（`multipart/form-data`：字段 `image`、`name`） |
| `GET` | `/api/maps/:id` | 图详情（尺寸、版本、全部区域） |
| `GET` | `/api/maps/:id/image` | 原图（PNG/JPEG，带 ETag 缓存） |
| `DELETE` | `/api/maps/:id` | 删除整张图 |
| `POST` | `/api/maps/:id/regions` | 新建区域 `{code, risk, points:[{x,y}]}` |
| `PUT` | `/api/maps/:id/regions/:rid` | 修改区域（必须带 `expectedVersion`） |
| `DELETE` | `/api/maps/:id/regions/:rid?expectedVersion=n` | 删除区域（乐观锁） |
| `GET` | `/api/maps/:id/events?after=n` | SSE 变更推送 |
| `GET` | `/api/maps/:id/export` | 导出整图 JSON |
| `POST` | `/api/import` | 导入整图 JSON（事务原子替换） |

错误响应统一为 `{ "error": "机器可读错误码", "detail": "中文原因说明" }`。

## 自测

```bash
npm test        # 即 node test/smoke.js
```

测试会临时拉起服务（独立临时数据库），覆盖：上传损坏图、自交/越界/重叠/重复编号拒绝、
乐观锁冲突、删除后旧提交不可恢复、SSE 补发、导出导入往返与坏数据整体拒绝（79 项断言）。

## 目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server/
│   ├── index.js       # HTTP 路由、上传、SSE、事务
│   ├── db.js          # SQLite 建表迁移、乐观锁、软删除、导入事务
│   ├── image.js       # PNG/JPEG 结构校验与尺寸解析（无第三方图像库）
│   └── validate.js    # 区域字段/几何校验、导入 JSON 严格校验
├── shared/
│   └── geometry.js    # 前后端共用的多边形几何校验
├── public/
│   ├── index.html
│   ├── app.js         # SVG 视口、绘制、版本冲突处理、SSE 合并
│   └── styles.css
└── test/smoke.js
```

## 安全与边界说明

- 应用设计为**本地/内网可信网络**使用，没有内置账号体系（需求明确无需第三方账号）；
  若暴露到公网，请放在带认证的反向代理之后。
- 上传大小受 `MAX_UPLOAD_MB` 限制；区域顶点数、区域数量、一次导入图数均有上限。
- 图片仅做结构与尺寸校验后原样存储，不做重编码，保证坐标与用户原图逐像素对应。
