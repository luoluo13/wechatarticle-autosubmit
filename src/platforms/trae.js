import fs from 'node:fs/promises';
import { openSession, ensureDebugDir, shot } from '../browser.js';
import { loadContent, normalizeTags, replaceImageSources } from './shared.js';

const EDITOR_URL = 'https://forum.trae.cn/new-topic';
const TITLE_SELECTOR = '#reply-title';
const BODY_SELECTOR = '.d-editor-input';
const MAX_TAGS = 5;

const readBody = (page) => page.locator(BODY_SELECTOR).first().inputValue();

/** 编辑器默认是富文本，正文用 Markdown 更可控，先切回源码模式 */
async function ensureMarkdownMode(page) {
  const body = page.locator(BODY_SELECTOR).first();
  await body.waitFor({ state: 'visible', timeout: 60000 });
  if ((await body.evaluate((el) => el.tagName)) === 'TEXTAREA') return;
  await page.locator('button.composer-toggle-switch').first().click();
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.tagName === 'TEXTAREA',
    BODY_SELECTOR,
    { timeout: 15000 },
  );
}

/** Discourse 的编辑器上传接口：带上 cookie 和 CSRF 头即可直接拿到 CDN 地址 */
async function uploadImages(page, images) {
  const urlMap = new Map();
  for (const image of images) {
    const ext = image.file.split('.').pop().toLowerCase();
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    const base64 = (await fs.readFile(image.file)).toString('base64');
    const result = await page.evaluate(
      async ({ base64: data, type, filename }) => {
        const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
        const form = new FormData();
        form.append('upload_type', 'composer');
        form.append('file', new File([bytes], filename, { type: `image/${type}` }));
        const response = await fetch('/uploads.json', {
          method: 'POST',
          headers: { 'X-CSRF-Token': csrf, Accept: 'application/json' },
          body: form,
        });
        if (!response.ok) return { error: `HTTP ${response.status}` };
        return response.json();
      },
      { base64, type: mime, filename: `${image.alt || 'image'}.${ext}` },
    );
    if (!result?.url) throw new Error(`TRAE 图片上传失败：${image.src}（${result?.error || '无返回地址'}）`);
    urlMap.set(image.src, result.url);
  }
  return urlMap;
}

async function fetchCategories(page) {
  await page.locator('details.category-chooser summary').first().click();
  await page.waitForTimeout(1200);
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('.select-kit-row[data-name]')]
      .filter((el) => el.getClientRects().length)
      .map((el) => el.getAttribute('data-name')),
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  return names;
}

async function pickCategory(page, name) {
  const names = await fetchCategories(page);
  if (!name || !names.includes(name)) {
    throw new Error(`TRAE 需要在发布弹窗里选择板块，可选：${names.join(' / ')}`);
  }
  await page.locator('details.category-chooser summary').first().click();
  await page.waitForTimeout(1000);
  await page.locator(`.select-kit-row[data-name="${name}"]`).first().click();
  await page.waitForTimeout(600);
  return name;
}

/** 部分板块不开放标签，没有输入框就跳过 */
async function addTags(page, tags) {
  const input = page.locator('.tag-chooser input').first();
  if (!tags.length || !(await input.count()) || !(await input.isVisible().catch(() => false))) {
    return [];
  }
  const added = [];
  await input.click();
  for (const tag of tags.slice(0, MAX_TAGS)) {
    await input.fill(tag);
    await page.waitForTimeout(1200);
    const row = page.locator('.select-kit-row').filter({ hasText: tag }).first();
    if (!(await row.isVisible().catch(() => false))) continue;
    await row.click();
    await page.waitForTimeout(500);
    added.push(tag);
  }
  return added;
}

async function waitPublishResult(page, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (/forum\.trae\.cn\/t\/[^/]+\/\d+/.test(page.url())) return { ok: true, url: page.url() };
    // 只认编辑器自己的报错，页面里别人的帖子标题会包含「失败」之类的字眼
    let hint = '';
    try {
      hint = await page.evaluate(() => {
        const nodes = [...document.querySelectorAll('.composer-error, .d-editor-container .alert-error, .modal-body .error')]
          .filter((el) => el.getClientRects().length)
          .map((el) => (el.innerText || '').trim())
          .filter(Boolean);
        return nodes.join(' / ').slice(0, 120);
      });
    } catch {
      await page.waitForTimeout(1500);
      continue;
    }
    if (hint) return { ok: false, note: hint };
    await page.waitForTimeout(1500);
  }
  return { ok: false, note: '等待发布结果超时，请查看截图确认' };
}

export default {
  id: 'trae',
  name: 'TRAE 社区',
  loginUrl: 'https://forum.trae.cn/login',
  homeUrl: 'https://forum.trae.cn/',
  editorUrl: EDITOR_URL,
  authCookies: ['_t'],
  optionsSpec: { category: 'required', tags: 'optional', tagsMax: MAX_TAGS },
  checkLogin: async (page) => (await page.locator('#current-user').count()) > 0,

  async fetchOptions({ headless = true } = {}) {
    const { browser, page } = await openSession('trae', { headless, url: EDITOR_URL });
    try {
      await page.locator('details.category-chooser summary').first().waitFor({ timeout: 60000 });
      return { categories: await fetchCategories(page) };
    } finally {
      await browser.close().catch(() => {});
    }
  },

  async publish(slug, { headless = false, execute = true, options = {} } = {}) {
    const content = await loadContent(slug);
    const chosen = normalizeTags(options.tags);
    const tags = chosen.length ? chosen : content.tags;

    const { browser, page } = await openSession('trae', {
      headless,
      url: EDITOR_URL,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const dir = await ensureDebugDir('trae');
    const shots = [];

    try {
      await ensureMarkdownMode(page);
      if (!(await page.locator('#current-user').count())) {
        throw new Error('TRAE 社区登录态已失效，请重新执行：node src/cli.js login trae');
      }

      await page.locator(TITLE_SELECTOR).fill(content.title);
      const urlMap = await uploadImages(page, content.images);
      await page.locator(BODY_SELECTOR).first().fill(replaceImageSources(content.markdown, urlMap));
      await page.waitForTimeout(1500);

      const category = await pickCategory(page, options.category || '');
      const addedTags = await addTags(page, tags);
      shots.push(await shot(page, dir, 'filled.png'));

      const notes = [
        `板块：${category}`,
        addedTags.length ? `标签：${addedTags.join(' / ')}` : '',
        urlMap.size ? `上传 ${urlMap.size} 张图片` : '',
      ].filter(Boolean);

      if (!execute) {
        return { ok: true, dry: true, note: notes.join('；'), shots };
      }

      await page.locator('button.create', { hasText: '创建话题' }).first().click();
      const result = await waitPublishResult(page);
      shots.push(await shot(page, dir, 'published.png'));
      return {
        ...result,
        note: [result.note, ...notes].filter(Boolean).join('；'),
        shots,
      };
    } finally {
      await browser.close().catch(() => {});
    }
  },
};
