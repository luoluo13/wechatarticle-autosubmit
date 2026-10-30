import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import matter from 'gray-matter';
import { root, dirs, DEFAULT_THEME } from './config.js';
import { buildArticle, listArticles, loadArticle } from './build.js';
import { hasAuth } from './browser.js';
import { PLATFORMS, getPlatform } from './platforms/index.js';
import { loginPlatform, loginMany } from './platforms/login.js';
import { normalizeTags } from './platforms/shared.js';

const PORT = Number(process.env.PORT || 4173);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(root, 'public');
const jobs = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------- 任务队列 --------------------------------- */

function captureConsole(job) {
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const wrap = (fn) => (...args) => {
    const line = args
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' ');
    job.logs.push(line);
    fn(...args);
  };
  console.log = wrap(originals.log);
  console.warn = wrap(originals.warn);
  console.error = wrap(originals.error);
  return () => Object.assign(console, originals);
}

function runCommand(job, command, args) {
  return new Promise((resolve, reject) => {
    job.logs.push(`$ ${command} ${args.join(' ')}`);
    const child = spawn(command, args, { cwd: root, shell: true });
    const push = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) job.logs.push(line);
      }
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`)),
    );
  });
}

/** 串行执行，避免两个浏览器会话同时操作后台 */
let queue = Promise.resolve();

function enqueue(task) {
  const id = crypto.randomUUID();
  const job = { id, status: 'queued', logs: [], result: null, error: null };
  jobs.set(id, job);

  queue = queue.then(async () => {
    job.status = 'running';
    const restore = captureConsole(job);
    try {
      job.result = await task(job);
      job.status = 'done';
    } catch (error) {
      job.error = error.message;
      job.status = 'error';
    } finally {
      restore();
      job.endedAt = Date.now();
    }
  });

  return id;
}

function toWebPath(file) {
  return `/${path.relative(root, file).split(path.sep).join('/')}`;
}

/** UI 传的封面是文章目录内的相对路径（如 assets/x.png），统一解析成绝对路径 */
function resolveCover(slug, cover) {
  if (!cover) return '';
  return path.isAbsolute(cover) ? cover : path.join(dirs.content, String(slug || ''), String(cover));
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object') return result;
  if (Array.isArray(result.shots)) return { ...result, shots: result.shots.map(toWebPath) };
  return result;
}

const ACTIONS = {
  build: (job, body) => buildArticle(body.slug),
  remove: async (job, body) => {
    const dir = path.join(dirs.content, body.slug);
    if (!(await exists(dir))) throw new Error(`文章 ${body.slug} 不存在`);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(path.join(dirs.build, body.slug), { recursive: true, force: true });
    return { slug: body.slug };
  },
  draft: (job, body) =>
    getPlatform('wechat').draft(body.slug, { headless: Boolean(body.headless) }),
  publish: (job, body) => {
    const platform = getPlatform(body.platform || 'wechat');
    return platform.publish(body.slug, {
      headless: Boolean(body.headless),
      execute: platform.id === 'wechat' ? Boolean(body.execute) : body.execute !== false,
      options: {
        category: String(body.options?.category || ''),
        tags: normalizeTags(body.options?.tags),
        cover: resolveCover(body.slug, body.options?.cover),
      },
    });
  },
  tags: (job, body) => {
    const platform = getPlatform(body.platform);
    if (!platform.fetchTags) return { tags: [] };
    return platform.fetchTags({ keyword: String(body.keyword || '') });
  },
  options: (job, body) => {
    const platform = getPlatform(body.platform);
    if (!platform.fetchOptions) return { categories: [] };
    return platform.fetchOptions({ headless: Boolean(body.headless) });
  },
  login: async (job, body) => {
    const platform = getPlatform(body.platform);
    if (platform.login) return platform.login({ headless: false });
    await loginPlatform(platform);
    return { ok: true, platform: platform.id };
  },
  loginAll: () => loginMany(PLATFORMS),
  open: (job, body) => {
    const platform = getPlatform(body.platform);
    const child = spawn(process.execPath, [path.join(root, 'src', 'cli.js'), 'open', platform.id], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: true, platform: platform.id, homeUrl: platform.homeUrl };
  },
  setup: async (job) => {
    await runCommand(job, 'npm', ['install']);
    await runCommand(job, 'npx', ['playwright', 'install', 'chromium']);
    return { ok: true };
  },
};

/* ---------------------------------- 数据读写 -------------------------------- */

const FIELDS = ['title', 'author', 'digest', 'theme', 'cover', 'tags'];

function pickFields(fields = {}) {
  const picked = {};
  for (const key of FIELDS) {
    if (fields[key] !== undefined && fields[key] !== null) picked[key] = fields[key];
  }
  return picked;
}

function safeSlug(slug) {
  const value = String(slug || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error('slug 只能包含字母、数字、点、下划线和短横线');
  }
  return value;
}

async function listThemes() {
  const files = await fs.readdir(dirs.themes).catch(() => []);
  return files
    .filter((file) => file.endsWith('.css') && !file.endsWith('.wechat.css'))
    .map((file) => file.replace(/\.css$/, ''))
    .sort();
}

async function readState() {
  const slugs = await listArticles();
  const articles = [];
  for (const slug of slugs) {
    try {
      const { fields } = await loadArticle(slug);
      articles.push({
        slug,
        title: fields.title || '(未命名)',
        author: fields.author || '',
        digest: fields.digest || '',
        theme: fields.theme || DEFAULT_THEME,
        built: await exists(path.join(dirs.build, slug, 'preview.html')),
      });
    } catch (error) {
      articles.push({ slug, title: slug, error: error.message, built: false });
    }
  }

  const playwrightCache =
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright')
      : path.join(os.homedir(), '.cache', 'ms-playwright');

  return {
    articles,
    themes: await listThemes(),
    platforms: await Promise.all(
      PLATFORMS.map(async (platform) => ({
        id: platform.id,
        name: platform.name,
        homeUrl: platform.homeUrl,
        optionsSpec: platform.optionsSpec,
        tagSuggest: Boolean(platform.fetchTags),
        auth: await hasAuth(platform.id),
      })),
    ),
    env: {
      deps: await exists(path.join(root, 'node_modules', 'playwright')),
      browsers: await exists(playwrightCache),
      node: process.version,
    },
  };
}

async function saveArticle(body) {
  const slug = safeSlug(body.slug);
  if (body.create && (await exists(path.join(dirs.content, slug)))) {
    throw new Error(`文章 ${slug} 已存在`);
  }

  const dir = path.join(dirs.content, slug);
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });

  const mdPath = path.join(dir, 'index.md');
  let frontMatter = {};
  if (!body.create) {
    try {
      frontMatter = matter(await fs.readFile(mdPath, 'utf8')).data;
    } catch {
      // 新文件没有 front-matter
    }
  }

  const markdown = String(body.markdown ?? '');
  await fs.writeFile(
    mdPath,
    Object.keys(frontMatter).length ? matter.stringify(markdown, frontMatter) : markdown,
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'article.json'),
    JSON.stringify(pickFields(body.fields), null, 2),
    'utf8',
  );

  return { slug };
}

async function saveAsset(body) {
  const slug = safeSlug(body.slug);
  const dir = path.join(dirs.content, slug, 'assets');
  await fs.mkdir(dir, { recursive: true });

  const base = path
    .basename(String(body.name || 'image.png'))
    .replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  const buffer = Buffer.from(String(body.data || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (!buffer.length) throw new Error('图片为空');
  if (buffer.length > 4 * 1024 * 1024) throw new Error('图片超过 4MB');

  let name = base;
  let index = 1;
  while (await exists(path.join(dir, name))) {
    const ext = path.extname(base);
    name = `${path.basename(base, ext)}-${index}${ext}`;
    index += 1;
  }
  await fs.writeFile(path.join(dir, name), buffer);
  return { path: `assets/${name}`, size: buffer.length };
}

async function readArticle(slug) {
  const { fields, markdown } = await loadArticle(safeSlug(slug));
  const assets = await fs.readdir(path.join(dirs.content, slug, 'assets')).catch(() => []);
  return {
    slug,
    fields: pickFields(fields),
    markdown,
    assets: assets.filter((file) => /\.(png|jpe?g|gif|webp|svg)$/i.test(file)),
  };
}

/* ---------------------------------- HTTP ---------------------------------- */

async function readJson(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function serveStatic(res, baseDir, urlPath) {
  const relative = path.normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const filePath = path.join(baseDir, relative);
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const { pathname } = url;

  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return serveStatic(res, PUBLIC_DIR, 'index.html');
    }
    if (req.method === 'GET' && (pathname === '/app.js' || pathname === '/styles.css')) {
      return serveStatic(res, PUBLIC_DIR, pathname.slice(1));
    }
    if (req.method === 'GET' && pathname.startsWith('/build/')) {
      return serveStatic(res, dirs.build, pathname.slice('/build/'.length));
    }
    if (req.method === 'GET' && pathname.startsWith('/content/')) {
      return serveStatic(res, dirs.content, pathname.slice('/content/'.length));
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, await readState());
    }

    if (req.method === 'GET' && pathname === '/api/article') {
      return sendJson(res, 200, await readArticle(url.searchParams.get('slug')));
    }

    if (req.method === 'POST' && pathname === '/api/article') {
      return sendJson(res, 200, await saveArticle(await readJson(req)));
    }

    if (req.method === 'POST' && pathname === '/api/asset') {
      return sendJson(res, 200, await saveAsset(await readJson(req)));
    }

    if (req.method === 'GET' && pathname === '/api/job') {
      const job = jobs.get(url.searchParams.get('id'));
      if (!job) return sendJson(res, 404, { error: '任务不存在' });
      return sendJson(res, 200, {
        status: job.status,
        logs: job.logs,
        result: normalizeResult(job.result),
        error: job.error,
      });
    }

    if (req.method === 'POST' && pathname === '/api/action') {
      const body = await readJson(req);
      const action = ACTIONS[body.action];
      if (!action) return sendJson(res, 400, { error: '未知操作' });
      if (body.action === 'login' && !body.platform) {
        return sendJson(res, 400, { error: '请指定要登录的平台' });
      }
      if (body.platform) getPlatform(body.platform);
      if (body.slug) body.slug = safeSlug(body.slug);
      const id = enqueue((job) => action(job, body));
      return sendJson(res, 200, { id });
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
});

// content/ 不入库，首次运行时自动建一个空目录，界面里直接「新建」即可
await fs.mkdir(dirs.content, { recursive: true });

server.listen(PORT, HOST, () => {
  console.log(`排字间已启动：http://${HOST}:${PORT}`);
  console.log('按 Ctrl+C 停止。浏览器自动化任务会在终端里打印进度。');
});
