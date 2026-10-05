'use strict';
const path = require('path');

/**
 * 全部配置均可通过环境变量覆盖（见 README）。
 */
const config = {
  // HTTP 监听端口
  port: parseInt(process.env.PORT || '8080', 10),
  // 监听地址；默认仅本机，需要局域网访问可设 0.0.0.0（容器内需 0.0.0.0）
  host: process.env.HOST || '0.0.0.0',
  // 数据目录：SQLite 数据库与上传原图都放这里
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  // 上传/导入文件大小上限（MB）。导入 JSON 内嵌 base64 图片，会略大，额外加 10MB。
  maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB || '30', 10),
  // 允许的图片类型
  allowedMime: new Set(['image/png', 'image/jpeg']),
};

config.dbFile = () => path.join(config.dataDir, 'annotator.db');
config.uploadDir = () => path.join(config.dataDir, 'uploads');
config.maxUploadBytes = () => config.maxUploadMb * 1024 * 1024;
// 导出 JSON 含 base64 图片，约为原图 4/3 倍，留足余量
config.maxImportBytes = () => (config.maxUploadMb + 16) * 1024 * 1024;

module.exports = config;
