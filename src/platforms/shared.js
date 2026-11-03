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
  const type = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  const base64 = (await fs.readFile(file)).toString('base64');
  await page.evaluate(
    async ({ base64: data, type: sourceType }) => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      let blob = new Blob([bytes], { type: sourceType });
      if (sourceType !== 'image/png') {
        // Chrome 的异步剪贴板只接受 PNG，JPEG/WebP 等要先转成 PNG 再写入
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        blob = await canvas.convertToBlob({ type: 'image/png' });
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    },
    { base64, type },
  );
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询直到 getter 返回真值；超时抛出带业务文案的错误 */
export async function pollUntil(
  getter,
  { timeout = 90000, interval = 1000, message = '等待超时' } = {},
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await getter();
    if (value) return value;
    await delay(interval);
  }
  throw new Error(message);
}

/**
 * 轮询发布结果：URL 跳转、成功提示、失败提示三种信号；
 * 页面在提交后可能被销毁，读取提示抛错时按「还没结束」继续等。
 */
export async function waitPublishResult(
  page,
  {
    urlPattern,
    readHint,
    successPattern = /发布成功/,
    failurePattern = /失败/,
    resolveUrl,
    timeout = 120000,
    interval = 1500,
  } = {},
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (urlPattern && urlPattern.test(page.url())) {
      return { ok: true, url: resolveUrl ? await resolveUrl(page) : page.url() };
    }
    let hint = '';
    try {
      hint = await readHint(page);
    } catch {
      await delay(interval);
      continue;
    }
    if (successPattern.test(hint)) return { ok: true, url: page.url(), note: hint };
    if (failurePattern.test(hint)) return { ok: false, note: hint };
    await delay(interval);
  }
  return { ok: false, note: '等待发布结果超时，请查看截图确认' };
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
