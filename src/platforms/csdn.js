import { openSession, ensureDebugDir, shot } from '../browser.js';
import {
  copyImageToClipboard,
  loadContent,
  normalizeTags,
  pollUntil,
  replaceImageSources,
  waitPublishResult,
} from './shared.js';

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
  return pollUntil(
    async () => {
      const text = await page.evaluate(
        (selector) => document.querySelector(selector)?.innerText || '',
        BODY_EDITOR,
      );
      return text.match(/https:\/\/[^\s)"']+\.(?:png|jpe?g|gif|webp)/i)?.[0] || '';
    },
    { timeout, interval: 1000, message: `CSDN 图片上传超时：${src}` },
  );
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

async function setStatement(page, dialog, statement) {
  if (!statement) return false;
  const select = dialog.locator('.creation-statement-select').first();
  if (!(await select.count())) return false;

  await select.click();
  const option = page
    .locator('.el-select-dropdown:visible .el-select-dropdown__item')
    .filter({ hasText: statement })
    .first();
  await option.waitFor({ state: 'visible', timeout: 8000 });
  await option.click();
  await page.waitForTimeout(300);
  return true;
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
  return pollUntil(
    async () => {
      const src = await dialog
        .locator('.container-coverimage-box img')
        .first()
        .getAttribute('src')
        .catch(() => '');
      return /i-blog\.csdnimg\.cn\/direct\//.test(src || '');
    },
    { timeout: 30000, interval: 1000, message: 'CSDN 封面未上传完成' },
  )
    .then(() => true)
    .catch(() => false);
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
      let box = matches.sort((a, b) => a.textContent.length - b.textContent.length)[0];
      // 标题本身通常是编辑器链接，要逐层向上找同一行里的「浏览」文章链接
      for (let i = 0; i < 5 && box?.parentElement; i += 1) {
        box = box.parentElement;
        const link = box.querySelector('a[href*="/article/details/"]');
        if (link) return link.href;
      }
      return '';
    }, title);
  } catch {
    return '';
  }
}

/**
 * 只读发布相关的提示元素：整页 innerText 会把弹窗后面的文章正文也算进来，
 * 正文里出现「失败」等词会误判成发布失败。
 */
const readPublishHint = (page) =>
  page.evaluate(() => {
    // 发布成功后 CSDN 会跳到独立结果页，正文已离开页面，可以整页判断
    const body = document.body.innerText || '';
    if (/发布成功[！!]?\s*正在审核中/.test(body)) return '发布成功，正在审核中';

    const nodes = [
      ...document.querySelectorAll(
        '.el-message, .el-message-box, .el-notification, .el-form-item__error',
      ),
    ].filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const text = nodes.map((el) => el.innerText || '').join('\n');
    const match = text.match(
      /[^\n]{0,40}(不能为空|最多|失败|请选择|请添加)[^\n]{0,40}/,
    );
    return match ? match[0].trim() : '';
  });

export default {
  id: 'csdn',
  name: 'CSDN',
  loginUrl: 'https://mp.csdn.net/',
  homeUrl: 'https://mp.csdn.net/',
  editorUrl: EDITOR_URL,
  authCookies: ['UserToken'],
  optionsSpec: {
    category: false,
    tags: 'required',
    tagsMax: MAX_TAGS,
    cover: true,
    statements: [
      '无声明',
      '部分内容由AI辅助生成',
      '内容来源网络，进行整合/再创作',
      '个人观点，仅供参考',
    ],
  },
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
      const statement = options.statement || '';
      const statementSet = await setStatement(page, dialog, statement);
      const coverFile = options.cover || content.cover;
      const coverOk = await setCover(page, dialog, coverFile);
      shots.push(await shot(page, dir, 'publish-dialog.png'));

      const notes = [
        urlMap.size ? `上传 ${urlMap.size} 张图片` : '',
        coverFile ? (coverOk ? '封面已上传' : '封面未上传，请在后台手动补') : '',
        statement ? `创作声明：${statementSet ? statement : '未设置成功'}` : '',
      ].filter(Boolean);

      if (!execute) {
        return { ok: true, dry: true, note: ['已填好发布表单', ...notes].join('；'), shots };
      }

      await dialog.locator('button:has-text("发布文章")').last().click();
      const result = await waitPublishResult(page, {
        urlPattern: /blog\.csdn\.net\/.*\/article\/details\/\d+/,
        readHint: readPublishHint,
        successPattern: /发布成功|审核中/,
        failurePattern: /不能为空|最多|失败|请选择|请添加/,
      });
      shots.push(await shot(page, dir, 'published.png'));
      const url = result.ok && !/blog\.csdn\.net\/.*\/article\/details\/\d+/.test(result.url || '')
        ? (await findArticleUrl(page, content.title)) || result.url
        : result.url;
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
