import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import MarkdownIt from 'markdown-it';
import juice from 'juice';
import { dirs, DEFAULT_THEME } from './config.js';
import { prepareTheme } from './theme.js';
import { inlineImages } from './assets.js';
import { checkWechatHtml } from './checker.js';

const md = new MarkdownIt({
  html: true,
  linkify: false,
  breaks: true, // 中文写作习惯：单个换行即换行
});

/** 非微信平台用的通用 HTML（保留 class，不套主题） */
export function renderBody(markdown) {
  return md.render(markdown);
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

export async function buildArticle(slug) {
  const { articleDir, fields, markdown } = await loadArticle(slug);

  const title = fields.title;
  if (!title) throw new Error(`${slug}: 缺少标题（front-matter 或 article.json 的 title）`);

  const themeName = fields.theme || DEFAULT_THEME;
  const { css, stats } = await prepareTheme(themeName);

  const rendered = md.render(markdown);
  // markdown-it 会给代码块加 class="language-xxx"，微信会剥离，这里直接去掉
  const cleanHtml = rendered.replace(/\sclass="[^"]*"/g, '');
  const { html: bodyHtml, warnings } = await inlineImages(cleanHtml, articleDir);

  const section = `<section id="nice">\n${bodyHtml.trim()}\n</section>`;
  const inlined = juice
    .inlineContent(section, css, {
      applyStyleTags: false,
      removeStyleTags: true,
      preserveImportant: true,
      inlinePseudoElements: false,
    })
    .trim();

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
    themeStats: stats,
    size: Buffer.byteLength(inlined, 'utf8'),
  };
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
