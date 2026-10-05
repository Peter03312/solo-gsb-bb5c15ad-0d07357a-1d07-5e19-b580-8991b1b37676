# 展馆平面图协作标注（Hall Plan Annotator）

本地运行的展馆平面图多人协作标注 Web 应用：上传 PNG / JPEG 平面图后，多个人可在同一图上
**缩放、平移、绘制多边形区域**，为每个区域填写**唯一编号**与**风险等级**。所有顶点按
**原图像素坐标**保存，换设备、刷新页面后位置完全一致。

- 技术栈：Node.js（Express）+ SQLite（better-sqlite3）+ 浏览器原生 SVG，无前端构建
- 完全本地运行，**不依赖任何第三方账号 / 外部服务**
- 数据库与原图保存在本地数据目录，可用 Docker 卷持久化

---

## 一、快速开始（Docker Compose，一键启动）

前置：已安装 Docker 与 Docker Compose 插件（Docker Desktop 自带）。

```bash
# 1. 在项目目录构建并后台启动（首次会自动初始化数据库与表结构）
docker compose up -d --build

# 2. 查看状态 / 日志
docker compose ps
docker compose logs -f

# 3. 停止（数据保留在 ./data，不会丢失）
docker compose down
```

启动后浏览器访问：

> **http://localhost:8080**

若宿主机 8080 端口被占用，改映射端口（容器内仍为 8080，无需改动应用）：

```bash
APP_PORT=18080 docker compose up -d --build
# 访问 http://localhost:18080
```

健康检查：`GET http://localhost:8080/api/plans`（返回 `{"plans":[...]}` 即正常）。

---

## 二、直接用 Node 运行（不使用 Docker）

要求 **Node.js >= 20**，无需全局安装其他工具。better-sqlite3 会安装预编译二进制
（无预编译时本机需具备 python3 / make / g++ 以从源码编译）。

```bash
# 1. 安装依赖
npm install

# 2. 初始化数据库（幂等；应用/容器启动时也会自动执行一次）
npm run migrate

# 3. 启动
npm start
```

默认访问：

> **http://localhost:8080**

运行测试：

```bash
npm test            # 几何校验单元测试（17 项）
```

---

## 三、配置项（全部通过环境变量设置，均有默认值）

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 监听端口（容器内） |
| `HOST` | `0.0.0.0` | 监听地址。仅本机访问可设 `127.0.0.1`；容器内必须为 `0.0.0.0` |
| `DATA_DIR` | `./data`（本地）/ `/data`（容器） | 数据目录：存放 SQLite 库 `annotator.db` 与 `uploads/` 原图 |
| `MAX_UPLOAD_MB` | `30` | 上传原图大小上限（MB）。导入 JSON 内嵌 base64 图片，导入上限自动额外 +16MB |
| `APP_PORT` | `8080` | 仅 Compose 使用：宿主机映射端口 |

示例：

```bash
PORT=9000 HOST=127.0.0.1 MAX_UPLOAD_MB=50 DATA_DIR=/var/lib/hpa npm start
```

数据目录结构：

```
data/
├── annotator.db        # SQLite 主库（WAL 模式另有 -wal/-shm 文件）
└── uploads/            # 按平面图 id 命名的原图 1.png / 1.jpg ...
```

> 备份：停止写入后复制整个 `DATA_DIR` 即可；也可以直接使用应用内的「导出整图 JSON」。

---

## 四、使用说明

1. 首页**上传平面图**（PNG/JPEG），或**导入整图 JSON**。
2. 打开图纸后：
   - **滚轮**以光标为中心缩放；**拖动空白处**平移；工具栏可放大/缩小/适应窗口/1:1。
   - 点击 **绘制新区域**：在图上**单击**逐个添加顶点，拖空白处仍可平移；
     **双击 / 回车**闭合多边形，`Esc` 取消。
   - 闭合后可拖动顶点修改形状（边中点的小手柄可插入新顶点），
     填写**唯一编号**与**风险等级**（低 / 中 / 高风险）后保存。
   - 点击已有区域或左侧列表可选中编辑；保存 / 删除均带版本号。
3. **导出整图 JSON**：单文件自包含（原图 base64 + 尺寸 + 区域 + 双方版本号），
   可在另一台机器导入恢复；同名平面图不会被覆盖，导入时可指定新名称。

多人协作：页面每 3 秒轮询一次最新数据。图纸与区域有任何变化都会收到提示，
区域列表与图纸版本实时刷新；正在编辑的草稿不会被刷新覆盖。

---

## 五、校验与冲突规则（需求实现说明）

### 形状校验（前后端使用同一份 `shared/geometry.js`，服务端为最终裁决）

保存、编辑、导入时都会拒绝下列形状，响应中给出**具体中文原因**：

- **自交**：非相邻边交叉、顶点触碰非相邻边（蝴蝶结等），即使是凹多边形只要简单多边形也允许；
- **越界**：任一顶点超出原图边界 `0..width / 0..height`，报错带顶点序号与坐标；
- **退化**：少于 3 个顶点、顶点重复、全部共线（面积为零）；
- **重叠**：与同一图上已有区域有任何面积重叠，或仅仅**边界相触**（共边、共角、顶点落在对方边上、包含、穿插），
  错误信息会指出冲突的对方编号与 id。

顶点保存前统一四舍五入到 0.001 像素；边界坐标 `0` 与 `width/height` 本身合法。

### 基于版本的并发控制（乐观锁）

- 每个**区域**有独立 `version`，每次保存 +1；每个**图纸**也有 `plan_version`，
  任何区域增删改都会 +1。
- 保存时必须带上编辑时所依据的 `version` 与 `plan_version`：
  - 区域已被他人更新 → **409 `VERSION_CONFLICT`**，提示双方版本号；
  - 图纸其他部分已被他人改动 → **409 `PLAN_VERSION_CONFLICT`**。
- 冲突时**未提交的编辑（编号、等级、所有顶点）原样保留在表单与画布上**，
  响应同时附带服务端最新快照，客户端自动刷新其他区域供比对合并。
- 删除同样校验版本，避免在不知情时删掉他人的新修改。
- 删除为**软删除墓碑**：区域对已删除区域的旧版本提交一律返回 **410 `REGION_DELETED`**，
  **无法再通过旧提交恢复**；界面可选择放弃，或把当前顶点转为「新建区域」重新保存。
  编号在删除后允许复用。

### 导出 / 导入的一致性与原子性

- 导出保留：原图、`width/height` 尺寸、全部区域（编号、风险等级、顶点原图坐标）、
  图纸版本与每个区域的版本号。
- 导入在**任何写入之前**完成全部校验：JSON 合法性、格式标识、尺寸、图片完整性、
  顶点范围、自交、文件内编号唯一、区域两两不重叠、版本号合法。
- 落库在单个 SQLite 事务内完成，图片先写临时文件再原子改名；
  **图片损坏或导入数据无效时，不会产生任何平面图、区域或半成品文件**。
- 上传损坏 / 截断 / 伪装的 PNG、JPEG 同样在写库前被拒绝，不留垃圾记录。

---

## 六、HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/plans` | multipart 上传 `image`（PNG/JPEG）与可选 `name` 新建图纸 |
| `GET` | `/api/plans` | 图纸列表 |
| `GET` | `/api/plans/:id` | 图纸详情（尺寸、图纸版本、全部区域） |
| `GET` | `/api/plans/:id/image` | 原图 |
| `PUT` | `/api/plans/:id` | 改名 / 替换原图（新图必须与原图**同尺寸**） |
| `POST` | `/api/plans/:id/regions` | 新建区域（`code`,`risk_level`,`vertices`,`plan_version`） |
| `PUT` | `/api/plans/:id/regions/:rid` | 更新区域（额外带区域 `version`） |
| `DELETE` | `/api/plans/:id/regions/:rid?version=&plan_version=` | 删除区域 |
| `GET` | `/api/plans/:id/export` | 下载整图 JSON |
| `POST` | `/api/import/file` | multipart 上传导出 JSON（可选 `name` 覆盖名称） |

顶点坐标格式：`vertices: [{"x": 120.5, "y": 88}, ...]`，均为**原图像素坐标**。
错误响应统一为：`{"error":"CODE","message":"中文原因", ...}`，冲突/删除响应另带 `server` 最新快照。

---

## 七、目录结构

```
.
├── Dockerfile                 # 单镜像构建（含原生模块编译兜底）
├── docker-compose.yml         # 一键启动 + 卷持久化 + 健康检查
├── docker/entrypoint.sh       # 容器入口：先迁移数据库再启动
├── package.json
├── server/
│   ├── app.js                 # Express 路由、事务、版本/冲突、导出导入
│   ├── config.js              # 环境变量配置
│   ├── db.js                  # SQLite 初始化 / 建表（可独立 npm run migrate）
│   └── image.js               # 纯 Node 解析 PNG/JPEG 尺寸与损坏检测
├── shared/
│   └── geometry.js            # 自交/越界/重叠校验（前后端共用）
├── public/
│   ├── index.html             # 单页界面（列表 + SVG 编辑器）
│   ├── styles.css
│   └── app.js                 # 缩放/平移/绘制/冲突保留/轮询协作
└── tests/
    └── geometry.test.js       # 几何规则单元测试
```

## 八、常见问题

- **换端口后打不开？** 容器内固定 8080；宿主机端口用 `APP_PORT` 控制。直接 Node 运行时用 `PORT`。
- **局域网其他设备访问？** Node 直跑设 `HOST=0.0.0.0`，防火墙放行对应端口后用 `http://<本机IP>:端口`。
- **上传大文件被拒？** 调大 `MAX_UPLOAD_MB`（导入 JSON 因含 base64 图片，限额自动更高）。
- **想清空全部数据？** `docker compose down` 后删除宿主机 `./data` 目录即可。
