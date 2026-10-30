import { openSession, ensureDebugDir, shot } from '../browser.js';
import { copyImageToClipboard, loadContent, normalizeTags, replaceImageSources } from './shared.js';

const EDITOR_URL = 'https://editor.csdn.net/md/';
const BODY_EDITOR = 'pre.editor__inner';
const MAX_TAGS = 5;

/** 剪切板写入纯文本后 Ctrl+V；Markdown 编辑器只认纯文本 */
async function pasteText(page, text) {
  await page.evaluate(
    async (payload) => {
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/plain': new Blob([payload], { type: 'text/plain' }) }),
      ]);
    },
    text,
  );
  await page.keyboard.press('Control+V');
}

async function clearBody(page) {
  await page.locator(BODY_EDITOR).click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
}

async function fillTitle(page, title) {
  // 标题输入框默认 display:none，必须先点输入区把它唤出来
  await page.locator('.article-bar__input-box').click();
  const input = page.locator('input.article-bar__title');
  await input.waitFor({ state: 'visible', timeout: 15000 });
  await input.fill(title);
}

/** 把本地图片粘贴进编辑器，让 CSDN 自己上传，再从正文里读回 CDN 地址 */
async function uploadImages(page, images) {
  const urlMap = new Map();
  for (const image of images) {
    await clearBody(page);
    await copyImageToClipboard(page, image.file);
    await page.keyboard.press('Control+V');
    urlMap.set(image.src, await waitForImageUrl(page, image.src));
  }
  if (images.length) await clearBody(page);
  return urlMap;
}

async function waitForImageUrl(page, src, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await page.evaluate(
      (selector) => document.querySelector(selector)?.innerText || '',
      BODY_EDITOR,
    );
    const match = text.match(/https:\/\/[^\s)"']+\.(?:png|jpe?g|gif|webp)/i);
    if (match) return match[0];
    await page.waitForTimeout(1000);
  }
  throw new Error(`CSDN 图片上传超时：${src}`);
}

async function openPublishDialog(page) {
  await page.locator('button.btn-publish').click();
  const dialog = page.locator('.modal__publish-article').first();
  await dialog.waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(1200);
  return dialog;
}

/** CSDN 会按正文自动预选 3 个标签，先清掉再换成用户选的，结果才可控 */
async function setTags(page, dialog, tags) {
  for (let guard = 0; guard < 10; guard += 1) {
    const auto = dialog.locator('.mark_selection_box_el_tag').first();
    if (!(await auto.count())) break;
    await auto.locator('.el-tag__close').click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
  }

  const list = tags.slice(0, MAX_TAGS);
  if (!list.length) return;
  await dialog.locator('.tag__btn-tag').first().click();
  const input = dialog.locator('input.el-input__inner').first();
  await input.waitFor({ state: 'visible', timeout: 10000 });
  for (const tag of list) {
    await input.fill(tag);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
  }
}

async function setCover(page, dialog, file) {
  if (!file) return false;
  const input = dialog.locator('input.el-upload__input').first();
  if (!(await input.count())) return false;
  await input.setInputFiles(file);

  // 选完文件会弹「图片编辑」裁剪层，点其中的「确认上传」才真正上传；不需要裁剪的图会直接上传
  const confirm = page.locator('.vue-image-crop-upload .vicp-operate-btn', { hasText: '确认上传' }).first();
  const cropAppeared = await confirm
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (cropAppeared) {
    await page.waitForTimeout(800);
    await confirm.click({ force: true });
  }

  // 封面是异步上传的，等预览图换成 i-blog.csdnimg.cn 的 CDN 地址再继续
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const src = await dialog
      .locator('.container-coverimage-box img')
      .first()
      .getAttribute('src')
      .catch(() => '');
    if (/i-blog\.csdnimg\.cn\/direct\//.test(src || '')) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

/** 发布成功后到文章管理里按标题找回链接（发布接口不直接给 URL） */
async function findArticleUrl(page, title) {
  try {
    await page.goto('https://mp.csdn.net/mp_blog/manage/article', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    return await page.evaluate((needle) => {
      const matches = [...document.querySelectorAll('div, li, tr')].filter((el) =>
        (el.textContent || '').includes(needle),
      );
      const smallest = matches.sort((a, b) => a.textContent.length - b.textContent.length)[0];
      return smallest?.querySelector('a[href*="/article/details/"]')?.href || '';
    }, title);
  } catch {
    return '';
  }
}

async function waitPublishResult(page, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (/blog\.csdn\.net\/.*\/article\/details\/\d+/.test(page.url())) {
      return { ok: true, url: page.url() };
    }
    const hint = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const match = text.match(/[^\n]{0,30}(发布成功|审核中|不能为空|最多|失败)[^\n]{0,30}/);
      return match ? match[0].trim() : '';
    });
    if (/发布成功/.test(hint)) return { ok: true, url: page.url(), note: hint };
    if (/不能为空|最多|失败/.test(hint)) return { ok: false, note: hint };
    await page.waitForTimeout(1500);
  }
  return { ok: false, note: '等待发布结果超时，请查看截图确认' };
}

export default {
  id: 'csdn',
  name: 'CSDN',
  loginUrl: 'https://mp.csdn.net/',
  homeUrl: 'https://mp.csdn.net/',
  editorUrl: EDITOR_URL,
  authCookies: ['UserToken'],
  optionsSpec: { category: false, tags: 'required', tagsMax: MAX_TAGS, cover: true },
  checkLogin: async (page) => /mp\.csdn\.net\/console/.test(page.url()),

  async publish(slug, { headless = false, execute = true, options = {} } = {}) {
    const content = await loadContent(slug);
    const chosenTags = normalizeTags(options.tags);
    const tags = chosenTags.length ? chosenTags : content.tags;
    if (!tags.length) throw new Error('CSDN 至少需要 1 个文章标签，请在发布弹窗里填写');

    const { browser, page } = await openSession('csdn', {
      headless,
      url: EDITOR_URL,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const dir = await ensureDebugDir('csdn');
    const shots = [];

    try {
      await page.locator(BODY_EDITOR).waitFor({ state: 'visible', timeout: 60000 });
      if (/passport\.csdn\.net|\/login/.test(page.url())) {
        throw new Error('CSDN 登录态已失效，请重新执行：node src/cli.js login csdn');
      }

      await fillTitle(page, content.title);
      const urlMap = await uploadImages(page, content.images);
      const markdown = replaceImageSources(content.markdown, urlMap);

      await clearBody(page);
      await pasteText(page, markdown);
      await page.waitForTimeout(2500);
      shots.push(await shot(page, dir, 'filled.png'));

      const dialog = await openPublishDialog(page);
      await setTags(page, dialog, tags);
      if (content.digest) {
        await dialog.locator('textarea.el-textarea__inner').fill(content.digest.slice(0, 256));
      }
      const coverFile = options.cover || content.cover;
      const coverOk = await setCover(page, dialog, coverFile);
      shots.push(await shot(page, dir, 'publish-dialog.png'));

      const notes = [
        urlMap.size ? `上传 ${urlMap.size} 张图片` : '',
        coverFile ? (coverOk ? '封面已上传' : '封面未上传，请在后台手动补') : '',
      ].filter(Boolean);

      if (!execute) {
        return { ok: true, dry: true, note: ['已填好发布表单', ...notes].join('；'), shots };
      }

      await dialog.locator('button:has-text("发布文章")').last().click();
      const result = await waitPublishResult(page);
      const url = result.ok && !result.url ? await findArticleUrl(page, content.title) : result.url;
      shots.push(await shot(page, dir, 'published.png'));
      return {
        ...result,
        url,
        note: [result.note, ...notes].filter(Boolean).join('；'),
        shots,
      };
    } finally {
      await browser.close().catch(() => {});
    }
  },
};
