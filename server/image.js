'use strict';

/**
 * 纯 Node 解析 PNG / JPEG 的像素尺寸并做基础完整性校验。
 * 不依赖第三方图像库：只读取文件头，足以拒绝错误类型与损坏文件。
 * 类型以「文件内容签名」为准，避免声明 MIME 与实际内容不符。
 *
 * @param {Buffer} buf
 * @param {string} [declaredMime]  调用方声明的 MIME（image/png | image/jpeg）
 * @returns {{width:number,height:number,mime:string}}
 * @throws  文件类型不符、头部损坏或尺寸非法
 */
function readImageSize(buf, declaredMime) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) {
    throw new Error('文件过小，不是有效的图片');
  }

  // PNG: 8 字节签名 + IHDR（长度4 + "IHDR" + 宽4 + 高4 ...）
  const isPngSignature =
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
  const isJpegSignature = buf[0] === 0xff && buf[1] === 0xd8;

  if (isPngSignature) {
    // 校验 IHDR 块及 IEND 结束标记，识别截断/损坏
    if (buf.length < 33 || buf.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error('PNG 头部损坏，缺少 IHDR 块');
    }
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (!validDim(width, height)) {
      throw new Error(`PNG 尺寸非法：${width}x${height}`);
    }
    // IEND 必须存在（损坏/截断常见表现）
    if (!hasMarker(buf, Buffer.from([0x49, 0x45, 0x4e, 0x44]))) {
      throw new Error('PNG 文件损坏：缺少 IEND 结束块（文件可能被截断）');
    }
    return { width, height, mime: 'image/png' };
  }

  if (isJpegSignature) {
    const dims = scanJpegMarkers(buf);
    if (!dims) {
      throw new Error('JPEG 文件损坏：未找到 SOF 帧（文件可能被截断或不是基线 JPEG）');
    }
    if (!validDim(dims.width, dims.height)) {
      throw new Error(`JPEG 尺寸非法：${dims.width}x${dims.height}`);
    }
    // EOI 结束标记
    if (!(buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9)) {
      throw new Error('JPEG 文件损坏：缺少 EOI 结束标记（文件可能被截断）');
    }
    return { width: dims.width, height: dims.height, mime: 'image/jpeg' };
  }

  throw new Error(
    `文件既不是 PNG 也不是 JPEG（文件头：${buf.slice(0, 4).toString('hex')}），` +
    `声明类型：${declaredMime || '未知'}`
  );
}

function validDim(w, h) {
  return Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 &&
         w <= 30000 && h <= 30000;
}

function hasMarker(buf, marker) {
  // 只在后 64KB 内查找即可（IEND 位于文件尾）
  const start = Math.max(0, buf.length - 65536);
  return buf.indexOf(marker, start) !== -1;
}

/**
 * 遍历 JPEG 标记段，在首个 SOFn（C0–CF，排除 DHT=C4、DAC=CC、JPG=C8）中读取尺寸。
 */
function scanJpegMarkers(buf) {
  let offset = 2; // 跳过 SOI
  while (offset + 4 < buf.length) {
    if (buf[offset] !== 0xff) {
      // 标记之间可能有填充字节
      offset++;
      continue;
    }
    let marker = buf[offset + 1];
    while (marker === 0xff && offset + 2 < buf.length) {
      offset++;
      marker = buf[offset + 1];
    }
    // 无长度字段的独立标记
    if (marker === 0xd8 || marker === 0xd9 ||
        (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buf.length) return null;
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2 || offset + 2 + segLen > buf.length) return null;

    if (marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // SOF: 长度(2) 精度(1) 高(2) 宽(2) ...
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    // SOS 之后是扫描数据，直接在剩余数据中找下一个标记意义不大；
    // SOF 一定在 SOS 之前，走到这里说明没有 SOF。
    if (marker === 0xda) return null;
    offset += 2 + segLen;
  }
  return null;
}

module.exports = { readImageSize };
