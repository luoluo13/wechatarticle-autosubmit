import { openSession, ensureDebugDir, shot } from '../browser.js';
import { copyImageToClipboard, loadContent, normalizeTags, replaceImageSources } from './shared.js';

const EDITOR_URL = 'https://i.cnblogs.com/posts/edit';
const TITLE_SELECTOR = '#post-title';
const BODY_SELECTOR = '#md-editor';
const MAX_TAGS = 5;

const readBody = (page) => page.locator(BODY_SELECTOR).inputValue();

/** 博客园的 Markdown 编辑器支持直接粘贴图片，会自动上传到 img2024.cnblogs.com */
async function pasteImage(page, file) {
  await copyImageToClipboard(page, file);
  const editor = page.locator(BODY_SELECTOR);
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Control+V');
}

async function uploadImages(page, images) {
  const urlMap = new Map();
  const editor = page.locator(BODY_SELECTOR);
  for (const image of images) {
    await editor.fill('');
    await pasteImage(page, image.file);
    urlMap.set(image.src, await waitForImageUrl(page, image.src));
  }
  if (images.length) await editor.fill('');
  return urlMap;
}

async function waitForImageUrl(page, src, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const match = (await readBody(page)).match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/);
    if (match) return match[1];
    await page.waitForTimeout(1000);
  }
  throw new Error(`博客园图片上传超时：${src}`);
}

/** 站点分类是单选框，input 被隐藏，只能点对应的 label */
async function pickCategory(page, name) {
  if (!name) return '';
  const radio = page.locator(`input[type=radio][name="site-cate-selector"][id="${name}"]`).first();
  if (!(await radio.count())) return '';
  const label = page.locator(`label[for="${name}"]`).first();
  if (await label.count()) await label.click({ force: true });
  else await radio.check({ force: true });
  return name;
}

/** 标签是 ant-select 的多选输入框，回车即新建；控件常被吸底栏遮挡，只能强制点击 */
async function addTags(page, tags) {
  const added = [];
  if (!tags.length) return added;
  const control = page.locator('.tags-select__control').first();
  await control.scrollIntoViewIfNeeded().catch(() => {});
  await control.click({ force: true });
  const input = control.locator('input').first();
  for (const tag of tags.slice(0, MAX_TAGS)) {
    await input.fill(tag);
    await page.waitForTimeout(600);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    const chips = (await control.locator('.ant-select-selection-item').allInnerTexts()).map((text) =>
      text.trim(),
    );
    if (chips.includes(tag)) added.push(tag);
  }
  return added;
}

/** 发布成功后会跳到 edit-done 页，用页头的「博客」链接拼出公开文章地址 */
async function resolvePostUrl(page, postId) {
  try {
    return await page.evaluate((id) => {
      const link = [...document.querySelectorAll('a[href^="https://www.cnblogs.com/"]')].find(
        (anchor) => (anchor.innerText || '').trim() === '博客',
      );
      if (!link) return '';
      const blogApp = link.href.replace(/\/+$/, '').split('/').pop();
      return `https://www.cnblogs.com/${blogApp}/p/${id}.html`;
    }, postId);
  } catch {
    return '';
  }
}

async function waitPublishResult(page, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const postId = page.url().match(/postId=(\d+)/)?.[1];
    if (postId) {
      return { ok: true, url: (await resolvePostUrl(page, postId)) || page.url() };
    }
    const hint = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const match = text.match(/[^\n]{0,20}(发布成功|保存成功|不能为空|失败)[^\n]{0,20}/);
      return match ? match[0].trim() : '';
    });
    if (/发布成功/.test(hint)) return { ok: true, url: page.url(), note: hint };
    if (/不能为空|失败/.test(hint)) return { ok: false, note: hint };
    await page.waitForTimeout(1500);
  }
  return { ok: false, note: '等待发布结果超时，请查看截图确认' };
}

export default {
  id: 'cnblogs',
  name: '博客园',
  loginUrl: 'https://account.cnblogs.com/signin?returnUrl=https%3A%2F%2Fi.cnblogs.com%2F',
  homeUrl: 'https://i.cnblogs.com/posts',
  editorUrl: EDITOR_URL,
  authCookies: ['.CNBlogsCookie', '.Cnblogs.AspNetCore.Cookies'],
  optionsSpec: { category: 'optional', tags: 'optional', tagsMax: MAX_TAGS },

  async fetchOptions({ headless = true } = {}) {
    const { browser, page } = await openSession('cnblogs', { headless, url: EDITOR_URL });
    try {
      const names = await page.evaluate(() =>
        [...document.querySelectorAll('input[type=radio][name="site-cate-selector"]')].map((el) => el.id),
      );
      return { categories: names };
    } finally {
      await browser.close().catch(() => {});
    }
  },

  async publish(slug, { headless = false, execute = true, options = {} } = {}) {
    const content = await loadContent(slug);
    const chosen = normalizeTags(options.tags);
    const tags = chosen.length ? chosen : content.tags;

    const { browser, page } = await openSession('cnblogs', {
      headless,
      url: EDITOR_URL,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const dir = await ensureDebugDir('cnblogs');
    const shots = [];

    try {
      await page.locator(TITLE_SELECTOR).waitFor({ state: 'visible', timeout: 60000 });
      await page.locator(TITLE_SELECTOR).fill(content.title);

      const urlMap = await uploadImages(page, content.images);
      await page.locator(BODY_SELECTOR).fill(replaceImageSources(content.markdown, urlMap));
      await page.waitForTimeout(1000);

      const category = await pickCategory(page, options.category || '');
      const addedTags = await addTags(page, tags);
      if (content.digest) {
        await page.locator('#summary').fill(content.digest).catch(() => {});
      }
      shots.push(await shot(page, dir, 'filled.png'));

      const notes = [
        category ? `分类：${category}` : '',
        addedTags.length ? `标签：${addedTags.join(' / ')}` : '',
        urlMap.size ? `上传 ${urlMap.size} 张图片` : '',
      ].filter(Boolean);

      if (!execute) {
        return { ok: true, dry: true, note: notes.join('；'), shots };
      }

      await page.locator('button', { hasText: '发布' }).filter({ hasNotText: '定时' }).first().click();
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
