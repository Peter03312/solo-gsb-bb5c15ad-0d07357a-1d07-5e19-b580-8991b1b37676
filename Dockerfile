# 展馆平面图协作标注 —— 单镜像运行
# better-sqlite3 为原生模块，在镜像内重新编译，避免宿主机架构差异
FROM node:20-bookworm-slim

# better-sqlite3 预编译二进制通常可直接下载；保留构建工具以兜底源码编译
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖，利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# 拷贝应用代码
COPY server ./server
COPY shared ./shared
COPY public ./public
COPY docker ./docker

# 数据目录（SQLite 数据库 + 上传原图），通过 volume 持久化
ENV DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8080
RUN mkdir -p /data
VOLUME ["/data"]

# 入口脚本：先初始化/迁移数据库，再启动服务
RUN chmod +x docker/entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/app/docker/entrypoint.sh"]
