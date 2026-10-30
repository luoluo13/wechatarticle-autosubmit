import fs from 'node:fs/promises';
import path from 'node:path';
import { loadArticle, renderBody } from '../build.js';

/** 统一把文章准备成「标题 + Markdown + 通用 HTML + 本地图片清单 + 封面」 */
export async function loadContent(slug) {
  const { articleDir, fields, markdown } = await loadArticle(slug);
  if (!fields.title) throw new Error(`${slug}: 缺少标题（front-matter 或 article.json 的 title）`);

  return {
    slug,
    title: fields.title,
    digest: fields.digest || '',
    author: fields.author || '',
    tags: normalizeTags(fields.tags),
    articleDir,
    markdown,
    html: renderBody(markdown),
    images: collectImages(markdown, articleDir),
    cover: await findCover(articleDir, fields.cover),
  };
}

/** 封面：优先用 front-matter 指定的文件，否则回退到 assets/cover.png */
async function findCover(articleDir, coverField) {
  for (const candidate of [coverField, path.join('assets', 'cover.png')]) {
    if (!candidate) continue;
    const file = path.resolve(articleDir, candidate);
    try {
      await fs.access(file);
      return file;
    } catch {
      // 换下一个候选
    }
  }
  return '';
}

/** 把本地图片写进剪贴板，配合 Ctrl+V 让平台编辑器自己上传 */
export async function copyImageToClipboard(page, file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  const base64 = (await fs.readFile(file)).toString('base64');
  await page.evaluate(
    async ({ base64: data, type }) => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      await navigator.clipboard.write([
        new ClipboardItem({ [`image/${type}`]: new Blob([bytes], { type: `image/${type}` }) }),
      ]);
    },
    { base64, type: mime },
  );
}

/** 标签统一成去重数组，兼容数组与「逗号/顿号/井号分隔」的字符串 */
export function normalizeTags(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : String(input).split(/[,，、#]+/);
  return [...new Set(list.map((tag) => String(tag).trim()).filter(Boolean))];
}

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

/** 把正文里的本地图片地址替换成平台返回的 CDN 地址（Markdown 与 HTML 通用） */
export function replaceImageSources(text, urlMap) {
  let out = text;
  const pairs = [...urlMap.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of pairs) out = out.split(from).join(to);
  return out;
}
