import fs from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser } from './browser.js';
import { WECHAT_INLINE_LIMIT } from './assets.js';

/** 各平台图片上传大小上限（字节）；没有配置的平台不压缩 */
export const IMAGE_LIMITS = {
  wechat: WECHAT_INLINE_LIMIT,
  juejin: 2 * 1024 * 1024,
};

/** 构建时按目标平台取上限；未配置的平台沿用构建产物自身的 2MB 内联限制 */
export function limitForPlatform(platform) {
  return IMAGE_LIMITS[platform] ?? IMAGE_LIMITS.wechat;
}

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const RASTER_MIME = new Set(Object.values(MIME_BY_EXT));

export function formatBytes(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)}MB`
    : `${Math.round(bytes / 1024)}KB`;
}

/**
 * 图片超过平台上限时才压缩，未超限或无上限返回 null，保持原文件不动。
 *
 * 压缩在已经打开的 Chromium 页面里用 canvas 完成：不透明图转高质 JPEG，
 * 带透明度的图保留 PNG，必要时逐步缩小尺寸；返回可直接交给
 * Playwright `setFiles` / `setInputFiles` 的文件载荷。
 */
export async function compressImageToLimit(page, file, limit, { maxSide = 4096, targetRatio = 0.98 } = {}) {
  if (!limit) return null;

  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    // 文件不存在时交给原流程报错，这里不改变行为
    return null;
  }
  if (stat.size <= limit) return null;

  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  const name = path.basename(file);
  if (!mime || !RASTER_MIME.has(mime)) {
    throw new Error(`图片 ${name} 超过 ${formatBytes(limit)}，且该格式不支持自动压缩`);
  }

  const base64 = (await fs.readFile(file)).toString('base64');
  const maxBytes = Math.floor(limit * targetRatio);

  const result = await page.evaluate(
    async ({ base64: data, mime: sourceMime, maxBytes: max, maxSide: side }) => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: sourceMime }));

      const toBlob = (canvas, type, quality) =>
        new Promise((resolve) => canvas.toBlob(resolve, type, quality));
      const toDataUrl = (blob) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });

      // 缩小采样检测透明度：透明图保留 PNG，其余转 JPEG（体积小很多）
      const probe = document.createElement('canvas');
      probe.width = 64;
      probe.height = 64;
      const probeCtx = probe.getContext('2d');
      probeCtx.drawImage(bitmap, 0, 0, 64, 64);
      const pixels = probeCtx.getImageData(0, 0, 64, 64).data;
      let hasAlpha = false;
      for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] < 250) {
          hasAlpha = true;
          break;
        }
      }
      const outputMime = hasAlpha ? 'image/png' : 'image/jpeg';

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      let scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));

      for (let step = 0; step < 14; step += 1) {
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        if (outputMime === 'image/jpeg') {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

        if (outputMime === 'image/png') {
          const blob = await toBlob(canvas, outputMime);
          if (blob && blob.size <= max) {
            return {
              dataUrl: await toDataUrl(blob),
              mime: outputMime,
              width: canvas.width,
              height: canvas.height,
            };
          }
        } else {
          // 质量越高体积越大：二分查找不超过上限的最高质量
          let lo = 0.3;
          let hi = 0.95;
          let best = null;
          for (let i = 0; i < 7; i += 1) {
            const quality = (lo + hi) / 2;
            const blob = await toBlob(canvas, outputMime, quality);
            if (!blob) break;
            if (blob.size <= max) {
              best = blob;
              lo = quality;
            } else {
              hi = quality;
            }
          }
          if (best) {
            return {
              dataUrl: await toDataUrl(best),
              mime: outputMime,
              width: canvas.width,
              height: canvas.height,
            };
          }
        }

        scale *= 0.85;
        if (scale < 0.15) break;
      }
      return null;
    },
    { base64, mime, maxBytes, maxSide },
  );

  if (!result) throw new Error(`图片 ${name} 压缩后仍超过 ${formatBytes(limit)}`);

  const buffer = Buffer.from(String(result.dataUrl).split(',')[1], 'base64');
  const outExt = result.mime === 'image/jpeg' ? 'jpg' : 'png';
  const payload = {
    name: `${path.basename(file, path.extname(file))}.${outExt}`,
    mimeType: result.mime,
    buffer,
  };

  if (mime === 'image/gif') console.log(`! ${name} 是 GIF，超过限制时会被压缩为静态图`);
  console.log(
    `· 压缩图片 ${name}：${formatBytes(stat.size)} → ${formatBytes(buffer.length)}（${result.width}×${result.height}）`,
  );

  return {
    payload,
    originalSize: stat.size,
    size: buffer.length,
    width: result.width,
    height: result.height,
    mime: result.mime,
  };
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** 压缩结果写回原目录；格式变了（如 png→jpg）就换文件名并删掉旧文件 */
async function replaceFile(file, compressed) {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  const ext = compressed.mime === 'image/jpeg' ? '.jpg' : '.png';
  let target = path.join(dir, base + ext);
  for (let index = 1; target !== file && (await pathExists(target)); index += 1) {
    target = path.join(dir, `${base}-${index}${ext}`);
  }
  await fs.writeFile(target, compressed.payload.buffer);
  if (target !== file) await fs.unlink(file).catch(() => {});
  return target;
}

/**
 * 构建阶段的批量压缩：只处理超过 limit 的图片，压缩结果直接覆盖原文件，
 * 返回 [{ source, target, ... }] 供调用方同步改写 Markdown / 封面引用。
 */
export async function compressAndReplace(files, limit) {
  const oversized = [];
  for (const file of new Set(files)) {
    try {
      const stat = await fs.stat(file);
      if (stat.size > limit) oversized.push(file);
    } catch {
      // 文件不存在交给后续流程报错，这里不改变行为
    }
  }
  if (!oversized.length) return [];

  const browser = await launchBrowser({ headless: true });
  try {
    const page = await browser.newPage();
    const results = [];
    for (const file of oversized) {
      const compressed = await compressImageToLimit(page, file, limit);
      if (!compressed) continue;
      const target = await replaceFile(file, compressed);
      results.push({ ...compressed, source: file, target });
    }
    return results;
  } finally {
    await browser.close().catch(() => {});
  }
}
