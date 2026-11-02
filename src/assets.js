import fs from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

export const WECHAT_INLINE_LIMIT = 2 * 1024 * 1024;

const MAX_BYTES = WECHAT_INLINE_LIMIT;

/**
 * 找出正文里的本地图片（Markdown 图片与原生 <img> 都算），
 * 外链和 data URI 不在此列，交给平台自己处理。
 */
export function collectImages(markdown, articleDir) {
  const refs = [];
  for (const match of markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    refs.push({ alt: match[1], src: match[2] });
  }
  for (const match of markdown.matchAll(/<img\b[^>]*\ssrc="([^"]+)"/g)) {
    refs.push({ alt: '', src: match[1] });
  }

  const seen = new Set();
  const images = [];
  for (const { alt, src } of refs) {
    if (seen.has(src) || /^(https?:)?\/\//i.test(src) || /^data:/i.test(src)) continue;
    seen.add(src);
    images.push({ src, alt, file: path.resolve(articleDir, decodeURI(src)) });
  }
  return images;
}

/**
 * 把正文里的本地图片转成 base64 内联。
 * 微信编辑器在粘贴时会把 data URI 图片自动转存到 mmbiz.qpic.cn，
 * 这是个人订阅号最省事的图片落地方案。
 */
export async function inlineImages(html, baseDir) {
  const warnings = [];
  const srcs = [...html.matchAll(/<img\b[^>]*?\ssrc="([^"]+)"/g)].map((m) => m[1]);
  let out = html;

  for (const src of new Set(srcs)) {
    if (/^data:/i.test(src)) continue;
    if (/^(https?:)?\/\//i.test(src)) {
      warnings.push(`外链图片在读者手机上不会显示，请改为本地图片：${src}`);
      continue;
    }

    const file = path.resolve(baseDir, decodeURI(src));
    const mime = MIME[path.extname(file).toLowerCase()];
    if (!mime) {
      warnings.push(`不支持的图片格式，已跳过：${src}`);
      continue;
    }

    let buf;
    try {
      buf = await fs.readFile(file);
    } catch {
      throw new Error(`图片不存在：${file}`);
    }
    if (buf.length > MAX_BYTES) {
      throw new Error(`图片超过 2MB 上限（${(buf.length / 1024 / 1024).toFixed(2)}MB）：${src}`);
    }

    const uri = `data:${mime};base64,${buf.toString('base64')}`;
    out = out.split(`src="${src}"`).join(`src="${uri}"`);
  }

  return { html: out, warnings };
}
