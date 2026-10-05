# 展馆平面图协作标注 —— 单镜像，零外部服务依赖
FROM node:20-bookworm-slim AS build

# 带上本地编译工具链：当目标平台没有 better-sqlite3 预编译二进制时可直接源码编译
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DB_PATH=/data/floorplan.db \
    MAX_UPLOAD_MB=100

# better-sqlite3 运行时需要的最小依赖已包含在 slim 镜像中
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY public ./public

RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]

USER node
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
