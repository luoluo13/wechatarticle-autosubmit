import fs from 'node:fs/promises';
import path from 'node:path';
import { loadArticle, renderBody, renderPlatformHtml } from '../build.js';
import { collectImages } from '../assets.js';

/** 统一把文章准备成「标题 + Markdown + 平台 HTML + 本地图片清单 + 封面」 */
export async function loadContent(slug, platform = '') {
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
    html: platform ? await renderPlatformHtml(markdown, fields, platform) : renderBody(markdown),
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

/** 把正文里的本地图片地址替换成平台返回的 CDN 地址（Markdown 与 HTML 通用） */
export function replaceImageSources(text, urlMap) {
  let out = text;
  const pairs = [...urlMap.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of pairs) out = out.split(from).join(to);
  return out;
}
