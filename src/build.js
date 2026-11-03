import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import MarkdownIt from 'markdown-it';
import juice from 'juice';
import { dirs, DEFAULT_THEMES } from './config.js';
import { isThemePlatform, prepareTheme } from './theme.js';
import { inlineImages, collectImages } from './assets.js';
import { checkWechatHtml } from './checker.js';
import { compressAndReplace, limitForPlatform } from './images.js';
import { pathExists } from './fsutil.js';

const md = new MarkdownIt({
  html: true,
  linkify: false,
  breaks: true, // 中文写作习惯：单个换行即换行
});

/** 非微信平台用的通用 HTML（保留 class，不套主题） */
export function renderBody(markdown) {
  return md.render(markdown);
}

const INLINE_OPTIONS = {
  applyStyleTags: false,
  removeStyleTags: true,
  preserveImportant: true,
  inlinePseudoElements: false,
};

/** 每个平台各自的主题；老数据只有 theme 字段时按公众号主题读取 */
export function themeFor(fields, platform) {
  if (!isThemePlatform(platform)) return '';
  const stored = fields?.themes && typeof fields.themes === 'object' ? fields.themes[platform] : '';
  if (typeof stored === 'string' && stored) return stored;
  if (platform === 'wechat' && typeof fields?.theme === 'string' && fields.theme) {
    return fields.theme;
  }
  return DEFAULT_THEMES[platform];
}

/** 知乎等「粘贴 HTML」的平台：套上该平台主题并逐条内联，图片地址保持原样 */
export async function renderPlatformHtml(markdown, fields, platform) {
  const rendered = md.render(markdown);
  if (!isThemePlatform(platform)) return rendered;

  const themeName = themeFor(fields, platform);
  const { css } = await prepareTheme(platform, themeName);
  const section = `<section id="nice">\n${rendered.trim()}\n</section>`;
  return juice.inlineContent(section, css, INLINE_OPTIONS).trim();
}

export async function listArticles() {
  let entries;
  try {
    entries = await fs.readdir(dirs.content, { withFileTypes: true });
  } catch {
    return [];
  }
  const slugs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await fs.access(path.join(dirs.content, entry.name, 'index.md'));
      slugs.push(entry.name);
    } catch {
      // 没有 index.md 的目录忽略
    }
  }
  return slugs.sort();
}

/**
 * 读取文章：正文来自 index.md，字段以 article.json（GUI 保存）为准，
 * 其次才是 index.md 的 front-matter，这样 GUI 里改字段不需要回写正文。
 */
export async function loadArticle(slug) {
  const articleDir = path.join(dirs.content, slug);
  let raw;
  try {
    raw = await fs.readFile(path.join(articleDir, 'index.md'), 'utf8');
  } catch {
    throw new Error(`找不到文章：${path.join(articleDir, 'index.md')}`);
  }

  const { data: frontMatter, content } = matter(raw);
  let sidecar = {};
  try {
    sidecar = JSON.parse(await fs.readFile(path.join(articleDir, 'article.json'), 'utf8'));
  } catch {
    // 没有 article.json 就只用 front-matter
  }

  const fields = { ...frontMatter };
  for (const [key, value] of Object.entries(sidecar)) {
    if (value !== '' && value !== null && value !== undefined) fields[key] = value;
  }

  return { articleDir, fields, markdown: content };
}

/** 换掉路径里的文件名，保留原目录写法（如 ./assets/a.png → ./assets/a.jpg） */
function swapFileName(src, targetFile) {
  const normalized = src.replace(/\\/g, '/');
  const dir = path.posix.dirname(normalized);
  const name = path.basename(targetFile);
  return dir === '.' ? name : `${dir}/${name}`;
}

/** 只允许处理文章目录内的文件，避免正文 / 封面引用把文件写到目录外 */
function isInside(dir, file) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 引用指向的文件不存在时，找同名的其它图片格式（压缩改名后的 1.jpg） */
async function findSiblingImage(file) {
  const base = file.replace(/\.[^.]+$/, '');
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
    const candidate = `${base}${ext}`;
    if (candidate !== file && (await pathExists(candidate))) return candidate;
  }
  return '';
}

/** 同时处理原文与 URL 编码后的写法，避免只替换了一处 */
function replaceRef(text, from, to) {
  let out = text.split(from).join(to);
  const encodedFrom = encodeURI(from);
  if (encodedFrom !== from) out = out.split(encodedFrom).join(encodeURI(to));
  return out;
}

/** 引用改名后同步回写 index.md 与 article.json，保证下次构建 / 发布仍然找得到图 */
async function rewriteRefs(articleDir, pairs) {
  if (!pairs.length) return;
  for (const name of ['index.md', 'article.json']) {
    const file = path.join(articleDir, name);
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    let next = raw;
    for (const [from, to] of pairs) next = replaceRef(next, from, to);
    if (next !== raw) await fs.writeFile(file, next, 'utf8');
  }
}

/** 修复指向已改名文件的引用（旧版压缩后没同步到的情况） */
async function healMissingRefs(articleDir, fields, markdown, pairs) {
  let nextMarkdown = markdown;
  const nextFields = { ...fields };

  for (const image of collectImages(markdown, articleDir)) {
    if (!isInside(articleDir, image.file)) continue;
    if (await pathExists(image.file)) continue;
    const replacement = await findSiblingImage(image.file);
    if (!replacement) continue;
    const to = swapFileName(image.src, replacement);
    pairs.push([image.src, to]);
    nextMarkdown = replaceRef(nextMarkdown, image.src, to);
  }

  if (nextFields.cover) {
    const coverFile = path.resolve(articleDir, nextFields.cover);
    if (isInside(articleDir, coverFile) && !(await pathExists(coverFile))) {
      const replacement = await findSiblingImage(coverFile);
      if (replacement) {
        const from = nextFields.cover;
        const to = swapFileName(from, replacement);
        pairs.push([from, to]);
        nextFields.cover = to;
      }
    }
  }

  return { fields: nextFields, markdown: nextMarkdown };
}

/** 构建时压缩超出目标平台上限的图片，返回改写后的字段与正文 */
async function prepareImages(articleDir, fields, markdown, platform) {
  const pairs = [];
  const healed = await healMissingRefs(articleDir, fields, markdown, pairs);
  const nextFields = healed.fields;
  let nextMarkdown = healed.markdown;

  const images = collectImages(nextMarkdown, articleDir).filter((image) =>
    isInside(articleDir, image.file),
  );
  const files = images.map((image) => image.file);
  if (nextFields.cover) {
    const coverFile = path.resolve(articleDir, nextFields.cover);
    if (isInside(articleDir, coverFile)) files.push(coverFile);
  }

  const changes = await compressAndReplace(files, limitForPlatform(platform));

  for (const change of changes) {
    for (const image of images.filter((item) => item.file === change.source)) {
      const to = swapFileName(image.src, change.target);
      pairs.push([image.src, to]);
      nextMarkdown = replaceRef(nextMarkdown, image.src, to);
    }
    if (nextFields.cover && path.resolve(articleDir, nextFields.cover) === change.source) {
      const from = nextFields.cover;
      const to = swapFileName(from, change.target);
      pairs.push([from, to]);
      nextFields.cover = to;
    }
  }

  await rewriteRefs(articleDir, pairs);
  if (pairs.length) {
    console.log(`· 已同步图片引用：${[...new Set(pairs.map(([from, to]) => `${from} → ${to}`))].join('，')}`);
  }

  return { fields: nextFields, markdown: nextMarkdown, renamed: pairs.length };
}

/**
 * imagePlatform 只决定构建时图片压缩所用的上限；
 * 正文主题固定使用微信公众号主题（其他平台粘贴的是同一份排版）。
 */
export async function buildArticle(slug, { imagePlatform = 'wechat' } = {}) {
  const { articleDir, fields: savedFields, markdown: savedMarkdown } = await loadArticle(slug);
  const title = savedFields.title;
  if (!title) throw new Error(`${slug}: 缺少标题（front-matter 或 article.json 的 title）`);

  // 构建前先处理超限图片：压缩结果覆盖原文件，并把正文 / 封面里的引用一起改名
  const { fields, markdown, renamed } = await prepareImages(
    articleDir,
    savedFields,
    savedMarkdown,
    imagePlatform,
  );

  const themeName = themeFor(fields, 'wechat');
  const { css, stats } = await prepareTheme('wechat', themeName);

  const rendered = md.render(markdown);
  // markdown-it 会给代码块加 class="language-xxx"，微信会剥离，这里直接去掉
  const cleanHtml = rendered.replace(/\sclass="[^"]*"/g, '');
  const { html: bodyHtml, warnings } = await inlineImages(cleanHtml, articleDir);

  const section = `<section id="nice">\n${bodyHtml.trim()}\n</section>`;
  const inlined = juice.inlineContent(section, css, INLINE_OPTIONS).trim();

  const issues = checkWechatHtml(inlined);
  if (issues.length) {
    throw new Error(`${slug}: 微信兼容性检查未通过\n  - ${issues.join('\n  - ')}`);
  }

  const digest = fields.digest || buildDigest(bodyHtml);
  const outDir = path.join(dirs.build, slug);
  await fs.mkdir(outDir, { recursive: true });

  await fs.writeFile(path.join(outDir, 'article.html'), inlined, 'utf8');
  await fs.writeFile(
    path.join(outDir, 'preview.html'),
    renderPreview({ slug, title, html: inlined }),
    'utf8',
  );
  await fs.writeFile(
    path.join(outDir, 'meta.json'),
    JSON.stringify(
      {
        slug,
        title,
        author: fields.author || '',
        digest,
        cover: fields.cover || '',
        theme: themeName,
        tags: fields.tags || [],
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );

  return {
    slug,
    title,
    digest,
    outDir,
    warnings,
    renamed,
    themeStats: stats,
    size: Buffer.byteLength(inlined, 'utf8'),
  };
}

async function mtimeOf(file) {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

/** 构建产物是否仍对应磁盘上的最新正文 / 字段 / 素材（容差 1 秒，兼容文件系统时间精度） */
export async function isBuildFresh(slug) {
  let meta;
  try {
    meta = JSON.parse(await fs.readFile(path.join(dirs.build, slug, 'meta.json'), 'utf8'));
  } catch {
    return false;
  }
  const builtAt = Date.parse(meta?.builtAt || '');
  if (!Number.isFinite(builtAt)) return false;

  const articleDir = path.join(dirs.content, slug);
  const mdPath = path.join(articleDir, 'index.md');
  const jsonPath = path.join(articleDir, 'article.json');

  let fields = {};
  try {
    fields = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  } catch {
    // 字段缺失时只校验正文与图片
  }
  const markdown = await fs.readFile(mdPath, 'utf8').catch(() => '');

  // 只校验真正参与构建的文件：正文、字段、正文引用的图片和已保存的封面。
  // 发布弹窗里临时导入的素材尚未被引用，不影响构建产物，不应判定为过期。
  const files = [mdPath, jsonPath];
  for (const image of collectImages(markdown, articleDir)) {
    if (isInside(articleDir, image.file)) files.push(image.file);
  }
  if (fields.cover) {
    const coverFile = path.resolve(articleDir, fields.cover);
    if (isInside(articleDir, coverFile)) files.push(coverFile);
  }

  let newest = 0;
  for (const file of files) newest = Math.max(newest, await mtimeOf(file));
  return newest <= builtAt + 1000;
}

/** 发布前必须已经构建过，且构建后稿件没有再被改动 */
export async function assertBuilt(slug) {
  if (!(await pathExists(path.join(dirs.build, slug, 'preview.html')))) {
    throw new Error(`《${slug}》还没有构建，请先点击「构建预览」再发布`);
  }
  if (!(await isBuildFresh(slug))) {
    throw new Error(`《${slug}》的正文、字段或正文引用的图片在构建后被修改过，请重新构建预览再发布`);
  }
}

function buildDigest(html) {
  const text = html
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 54 ? `${text.slice(0, 54)}…` : text;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderPreview({ slug, title, html }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · 预览</title>
<style>
  body{margin:0;background:#f2f3f5;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}
  .bar{position:sticky;top:0;display:flex;align-items:center;gap:12px;padding:10px 20px;background:#fff;border-bottom:1px solid #e8e8e8;z-index:10;}
  .bar .name{flex:1;overflow:hidden;font-size:13px;color:#888;white-space:nowrap;text-overflow:ellipsis;}
  .bar button{appearance:none;border:0;border-radius:6px;background:#ff6a29;color:#fff;font-size:13px;padding:8px 16px;cursor:pointer;}
  .hint{max-width:677px;margin:20px auto -8px;padding:0 4px;font-size:12px;color:#9a9a9a;}
  .stage{max-width:677px;margin:20px auto 80px;padding:36px 28px;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.06);}
</style>
</head>
<body>
<div class="bar">
  <span class="name">${escapeHtml(slug)} · ${escapeHtml(title)}</span>
  <button id="copy">复制正文</button>
</div>
<div class="hint">点「复制正文」后到公众号后台编辑器 Ctrl+V 粘贴，图片会随粘贴自动上传。</div>
<div class="stage" id="stage">
${html}
</div>
<script>
(function () {
  var btn = document.getElementById('copy');
  btn.addEventListener('click', async function () {
    var stage = document.getElementById('stage');
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([stage.innerHTML], { type: 'text/html' }),
        'text/plain': new Blob([stage.innerText], { type: 'text/plain' })
      })]);
      btn.textContent = '已复制';
    } catch (err) {
      var range = document.createRange();
      range.selectNodeContents(stage);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      btn.textContent = '已选中，请按 Ctrl+C';
    }
    setTimeout(function () { btn.textContent = '复制正文'; }, 2000);
  });
})();
</script>
</body>
</html>`;
}
