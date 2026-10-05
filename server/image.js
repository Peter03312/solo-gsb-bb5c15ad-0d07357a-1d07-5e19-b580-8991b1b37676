/**
 * server/image.js — 最小化 PNG/JPEG 解析，读取尺寸并验证文件结构。
 * 不依赖任何第三方图像库；损坏文件抛 ImageError，不会进入数据库或落盘。
 */

export class ImageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageError';
  }
}

export const SUPPORTED_MIME = {
  'image/png': { ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  'image/jpeg': { ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
};

/**
 * @param {Buffer} buf
 * @param {string} declaredMime
 * @returns {{width:number, height:number, mimeType:string}}
 */
export function readImageInfo(buf, declaredMime) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) {
    throw new ImageError('图片为空或文件过小，不是有效的 PNG/JPEG 文件');
  }

  const sniffed = sniffMime(buf);
  const mime = sniffed ?? declaredMime;
  if (!SUPPORTED_MIME[mime]) {
    throw new ImageError(`不支持的图片类型：${declaredMime || '未知'}，仅支持 PNG 与 JPEG`);
  }
  if (sniffed && declaredMime && sniffed !== declaredMime) {
    throw new ImageError('文件内容与上传类型不符');
  }
  if (!sniffed) {
    throw new ImageError('文件头不是有效的 PNG/JPEG 签名，文件可能已损坏');
  }

  return mime === 'image/png' ? readPng(buf) : readJpeg(buf);
}

function sniffMime(buf) {
  for (const [mime, def] of Object.entries(SUPPORTED_MIME)) {
    if (def.magic.every((b, i) => buf[i] === b)) return mime;
  }
  return null;
}

function readPng(buf) {
  // 8 字节签名 + IHDR：长度(4) + 'IHDR'(4) + 宽(4) + 高(4)
  if (buf.length < 24) throw new ImageError('PNG 文件被截断（缺少 IHDR 块）');
  if (buf.toString('ascii', 12, 16) !== 'IHDR') {
    throw new ImageError('PNG 文件结构损坏（缺少 IHDR 块）');
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) throw new ImageError('PNG 尺寸为 0，文件无效');

  // IEND 结尾校验
  if (buf.length < 12 || buf.toString('ascii', buf.length - 8, buf.length - 4) !== 'IEND') {
    throw new ImageError('PNG 文件缺少 IEND 结束块，文件已损坏或被截断');
  }
  return { width, height, mimeType: 'image/png' };
}

function readJpeg(buf) {
  // 遍历 JPEG 标记段，找到 SOFn（0xC0–0xCF，排除 C4/C8/CAC）读取尺寸
  let offset = 2; // 跳过 SOI
  while (offset + 4 < buf.length) {
    if (buf[offset] !== 0xff) {
      // 跳过填充字节
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker === 0xd9) break; // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2 || offset + 2 + segLen > buf.length) {
      throw new ImageError('JPEG 标记段长度越界，文件已损坏或被截断');
    }
    if (
      (marker >= 0xc0 && marker <= 0xcf) &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      if (width === 0 || height === 0) throw new ImageError('JPEG 尺寸为 0，文件无效');
      return { width, height, mimeType: 'image/jpeg' };
    }
    offset += 2 + segLen;
  }
  throw new ImageError('JPEG 中未找到帧起始标记(SOF)，文件已损坏');
}
