import { openSession, ensureDebugDir, shot } from '../browser.js';
import { copyImageToClipboard, loadContent, normalizeTags, replaceImageSources } from './shared.js';

const EDITOR_URL = 'https://zhuanlan.zhihu.com/write';
const TITLE_SELECTOR = 'textarea[placeholder^="请输入标题"]';
const BODY_EDITOR = 'div.public-DraftEditor-content';
const TOPIC_INPUT = 'input[placeholder="搜索话题..."]';
const MAX_TOPICS = 3;

const readBody = (page) =>
  page.evaluate((selector) => document.querySelector(selector)?.innerText || '', BODY_EDITOR);

const readImageUrls = (page) =>
  page.evaluate(
    (selector) =>
      [...document.querySelectorAll(`${selector} img`)].map((img) => img.src).filter(Boolean),
    BODY_EDITOR,
  );

/** 知乎的新版编辑器没有可用的图片 file input，往剪贴板写图片再粘贴最稳 */
async function pasteImage(page, file) {
  await copyImageToClipboard(page, file);
  await page.keyboard.press('Control+V');
}

/** 清空正文；图片占位块会让 Ctrl+A 失效，多试几轮直到真正空掉 */
async function clearBody(page) {
  for (let round = 0; round < 4; round += 1) {
    await page.locator(BODY_EDITOR).click({ position: { x: 8, y: 8 } }).catch(() => {});
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(500);
    const empty = (await readBody(page)).trim() === '' && (await readImageUrls(page)).length === 0;
    if (empty) return;
  }
  throw new Error('知乎正文清空失败，编辑器里仍有残留内容');
}

async function uploadImages(page, images, dir) {
  const urlMap = new Map();
  for (const image of images) {
    await clearBody(page);
    await page.locator(BODY_EDITOR).click({ position: { x: 8, y: 8 } });
    await pasteImage(page, image.file);
    try {
      urlMap.set(image.src, await waitForImageUrl(page, image.src));
    } catch (error) {
      await shot(page, dir, 'upload-failed.png');
      throw error;
    }
  }
  if (images.length) await clearBody(page);
  return urlMap;
}

/** 图片先以 blob 占位，上传完成后才换成 zhimg 的 CDN 地址 */
async function waitForImageUrl(page, src, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const urls = await readImageUrls(page);
    // 上传完成后地址从 blob: 换成 pic-private.zhihu.com / picX.zhimg.com
    const remote = urls.find((url) => /^https:\/\/[\w.-]*(zhimg|zhihu)\.com\//i.test(url));
    if (remote) return remote;
    await page.waitForTimeout(1000);
  }
  throw new Error(`知乎图片上传超时：${src}`);
}

async function pasteHtml(page, html) {
  await page.locator(BODY_EDITOR).click({ position: { x: 8, y: 8 } });
  await page.evaluate(
    async (payload) => {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([payload], { type: 'text/html' }),
          'text/plain': new Blob([payload.replace(/<[^>]+>/g, '\n')], { type: 'text/plain' }),
        }),
      ]);
    },
    html,
  );
  await page.keyboard.press('Control+V');
}

async function openSettings(page) {
  const button = page.locator('button', { hasText: '发布设置' }).first();
  if (await button.count()) {
    await button.click();
    await page.waitForTimeout(800);
  }
}

/** 话题是必填项，且只能从平台搜索结果里选 */
async function addTopics(page, topics) {
  await openSettings(page);
  const added = [];
  const skipped = [];
  for (const topic of topics.slice(0, MAX_TOPICS)) {
    // 搜索框一直在 DOM 里，只是没点「添加话题」前不可见
    const input = page.locator(TOPIC_INPUT).first();
    if (!(await input.isVisible().catch(() => false))) {
      await page.getByText('添加话题', { exact: true }).first().click().catch(() => {});
      await page.waitForTimeout(800);
    }
    if (!(await input.isVisible().catch(() => false))) {
      skipped.push(topic);
      continue;
    }

    await input.click();
    await input.fill(topic);
    await page.waitForTimeout(2000);
    // 话题建议不一定和原文完全一致（如 ArchLinux / Arch Linux），按「完全匹配 > 前缀 > 包含」挑，同级别取最短
    const options = page.locator('[class*="Popover-content"] button:visible');
    const names = (await options.allInnerTexts()).map((name) => name.trim()).filter(Boolean);
    const norm = (value) => value.replace(/\s+/g, '').toLowerCase();
    const needle = norm(topic);
    const rank = (name) => {
      const value = norm(name);
      if (value === needle) return 0;
      if (value.startsWith(needle)) return 1;
      if (value.includes(needle)) return 2;
      return 3;
    };
    const picked = names
      .filter((name) => rank(name) < 3)
      .sort((a, b) => rank(a) - rank(b) || a.length - b.length)[0];
    if (!picked) {
      skipped.push(topic);
      await input.fill('');
      continue;
    }
    await options.filter({ hasText: picked }).first().click();
    await page.waitForTimeout(800);
    added.push(picked);
  }
  return { added, skipped };
}

/** 点真发布按钮（底部主按钮），如果弹出确认框再点一次 */
async function submitPublish(page) {
  await page.locator('button.Button--primary', { hasText: '发布' }).last().click();
  await page.waitForTimeout(2500);
  const confirm = page.locator('.Modal button', { hasText: /^(确认)?发布$/ }).last();
  if (await confirm.count()) {
    await confirm.click().catch(() => {});
  }
}

async function waitPublishResult(page, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (/zhuanlan\.zhihu\.com\/p\/\d+/.test(page.url())) return { ok: true, url: page.url() };
    let hint = '';
    try {
      hint = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const match = text.match(/[^\n]{0,20}(发布成功|请添加话题|话题|不能为空|失败)[^\n]{0,20}/);
        return match ? match[0].trim() : '';
      });
    } catch {
      await page.waitForTimeout(1500);
      continue;
    }
    if (/发布成功/.test(hint)) return { ok: true, url: page.url(), note: hint };
    if (/请添加话题|不能为空|失败/.test(hint)) return { ok: false, note: hint };
    await page.waitForTimeout(1500);
  }
  return { ok: false, note: '等待发布结果超时，请查看截图确认' };
}

export default {
  id: 'zhihu',
  name: '知乎',
  loginUrl: 'https://www.zhihu.com/signin?next=%2F',
  homeUrl: 'https://www.zhihu.com/creator',
  editorUrl: EDITOR_URL,
  authCookies: ['z_c0'],
  optionsSpec: { category: false, tags: 'required', tagsMax: MAX_TOPICS },
  checkLogin: async (page) => /zhihu\.com/.test(page.url()) && !/signin|login/.test(page.url()),

  async publish(slug, { headless = false, execute = true, options = {} } = {}) {
    const content = await loadContent(slug);
    const chosen = normalizeTags(options.tags);
    const topics = chosen.length ? chosen : content.tags;
    if (!topics.length) throw new Error('知乎至少需要 1 个话题，请在发布弹窗里填写');

    const { browser, page } = await openSession('zhihu', {
      headless,
      url: EDITOR_URL,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const dir = await ensureDebugDir('zhihu');
    const shots = [];

    try {
      await page.locator(TITLE_SELECTOR).waitFor({ state: 'visible', timeout: 60000 });
      if (/signin|login/.test(page.url())) {
        throw new Error('知乎登录态已失效，请重新执行：node src/cli.js login zhihu');
      }

      await page.locator(TITLE_SELECTOR).fill(content.title);
      const urlMap = await uploadImages(page, content.images, dir);

      await pasteHtml(page, replaceImageSources(content.html, urlMap));
      await page.waitForTimeout(2500);
      shots.push(await shot(page, dir, 'filled.png'));

      const topicResult = await addTopics(page, topics);
      if (!topicResult.added.length) {
        throw new Error(`知乎话题没有添加成功（${topics.join(' / ')}），请手动检查`);
      }
      shots.push(await shot(page, dir, 'publish-settings.png'));

      const notes = [
        `话题：${topicResult.added.join(' / ')}`,
        topicResult.skipped.length ? `平台无此话题已跳过：${topicResult.skipped.join(' / ')}` : '',
        urlMap.size ? `上传 ${urlMap.size} 张图片` : '',
      ].filter(Boolean);

      if (!execute) {
        return { ok: true, dry: true, note: notes.join('；'), shots };
      }

      await submitPublish(page);
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
