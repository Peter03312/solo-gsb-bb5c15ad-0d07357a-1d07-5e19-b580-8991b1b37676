#!/bin/sh
# 容器入口：幂等初始化 SQLite 表结构，然后启动应用
set -e

echo "==> 初始化/检查数据库（数据目录: ${DATA_DIR:-/data}）"
node server/db.js

echo "==> 启动展馆平面图协作标注服务（${HOST:-0.0.0.0}:${PORT:-8080}）"
exec node server/app.js
