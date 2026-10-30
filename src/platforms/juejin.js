import { openSession, ensureDebugDir, readAuth, shot } from '../browser.js';
import { loadContent, normalizeTags, replaceImageSources } from './shared.js';

const EDITOR_URL = 'https://juejin.cn/editor/drafts/new';
const BODY_EDITOR = '.CodeMirror';
const MAX_TAGS = 5;

const setBody = (page, text) =>
  page.evaluate((value) => {
    document.querySelector('.CodeMirror').CodeMirror.setValue(value);
  }, text);

const readBody = (page) =>
  page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());

/** 工具栏图标没有 title，只能挨个试，哪个触发文件选择就是图片按钮 */
async function openImageChooser(page) {
  const icons = page.locator('.bytemd-toolbar-left .bytemd-toolbar-icon');
  const total = await icons.count();
  for (let index = 0; index < total; index += 1) {
    const chooser = page.waitForEvent('filechooser', { timeout: 1500 }).catch(() => null);
    await icons.nth(index).click({ timeout: 3000 }).catch(() => {});
    const result = await chooser;
    if (result) return result;
  }
  throw new Error('没找到掘金编辑器的图片上传按钮');
}

async function uploadImages(page, images) {
  const urlMap = new Map();
  for (const image of images) {
    await setBody(page, '');
    const chooser = await openImageChooser(page);
    await chooser.setFiles(image.file);
    urlMap.set(image.src, await waitForImageUrl(page, image.src));
  }
  if (images.length) await setBody(page, '');
  return urlMap;
}

async function waitForImageUrl(page, src, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const match = (await readBody(page)).match(/!\[[^\]]*\]\((https:\/\/[^)]+)\)/);
    if (match) return match[1];
    await page.waitForTimeout(1000);
  }
  throw new Error(`掘金图片上传超时：${src}`);
}

async function openPublishPanel(page) {
  await page.locator('button.xitu-btn', { hasText: '发布' }).first().click();
  const panel = page.locator('.publish-popup.active .panel');
  await panel.waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(800);
  return panel;
}

async function pickCategory(page, panel, name) {
  const items = panel.locator('.category-list .item');
  const count = await items.count();
  if (!count) throw new Error('掘金发布面板里没找到分类选项');
  const names = [];
  for (let index = 0; index < count; index += 1) names.push((await items.nth(index).innerText()).trim());
  if (name && !names.includes(name)) {
    throw new Error(`掘金没有「${name}」这个分类，可选：${names.join(' / ')}`);
  }

  const target = name || names[0];
  // 分类必选，点完要确认对应项真的带上了 active，否则发布会被平台拦下
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await items.filter({ hasText: target }).first().click();
    await page.waitForTimeout(500);
    const active = await panel
      .locator('.category-list .item.active')
      .first()
      .innerText()
      .catch(() => '');
    if (active.trim() === target) return { picked: target, names };
  }
  throw new Error(`掘金分类没有选中：${target}，可选：${names.join(' / ')}`);
}

/** 掘金只能选站内已有标签，直接调它的标签接口查询（不需要开浏览器） */
async function queryTagNames(keyword) {
  const state = await readAuth('juejin');
  const cookie = (state?.cookies || [])
    .filter((item) => String(item.domain || '').includes('juejin.cn'))
    .map((item) => `${item.name}=${item.value}`)
    .join('; ');

  const res = await fetch('https://api.juejin.cn/tag_api/v1/query_tag_list?aid=2608', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://juejin.cn',
      Referer: 'https://juejin.cn/',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ cursor: '0', key_word: keyword, limit: 10, sort_type: 1 }),
  });
  if (!res.ok) throw new Error(`掘金标签接口返回 ${res.status}`);
  const json = await res.json().catch(() => ({}));
  return (json.data || [])
    .map((item) => item.tag?.tag_name)
    .filter(Boolean)
    .map((name) => name.trim());
}

async function resolveTags(tags) {
  const plan = { names: [], missing: [] };
  for (const tag of tags) {
    const found = await queryTagNames(tag).catch(() => []);
    if (found.includes(tag)) plan.names.push(tag);
    else plan.missing.push({ name: tag, candidates: found.filter((name) => name !== tag).slice(0, 3) });
  }
  return plan;
}

function describeMissing(plan) {
  const detail = plan.missing
    .map((item) => (item.candidates.length ? `${item.name}（相近：${item.candidates.join(' / ')}）` : item.name))
    .join('、');
  return `掘金站内没有这些标签：${detail}`;
}

async function addTags(page, panel, names) {
  if (!names.length) return { added: [], limit: null };
  const tagBox = panel.locator('.tag-input').first();
  await tagBox.locator('.byte-select__placeholder').click();
  const input = tagBox.locator('input.byte-select__input');

  // 面板会提示「你还能够添加 N 个标签」，据此判断还能不能再加（不同账号上限不同）
  const remainingOf = () =>
    page.evaluate(() => {
      const text = [...document.querySelectorAll('div, span, li')]
        .filter((el) => !el.children.length)
        .map((el) => (el.textContent || '').trim())
        .find((value) => /你还能够添加\s*\d+\s*个标签/.test(value));
      const match = text?.match(/你还能够添加\s*(\d+)\s*个标签/);
      return match ? Number(match[1]) : null;
    });

  let remaining = await remainingOf();
  const initialLeft = remaining;
  const added = [];

  for (const name of names) {
    if (remaining !== null && remaining <= 0) break;
    let done = false;
    // 搜索结果是异步的，而且同名选项可能出现在多个下拉里，只点当前可见的那一个
    for (let attempt = 0; attempt < 8 && !done; attempt += 1) {
      await input.fill(name);
      await page.waitForTimeout(700);
      const options = page.locator('.byte-select-option:visible');
      const texts = await options.allInnerTexts().catch(() => []);
      const index = texts.findIndex((text) => text.trim() === name);
      if (index < 0) continue;
      await options.nth(index).click();
      await page.waitForTimeout(600);
      // 选中后会变成一个 chip，用 chip 元素确认真的加上了
      done = Boolean(await tagBox.locator('.byte-select__tag').filter({ hasText: name }).count());
    }
    if (done) {
      added.push(name);
      remaining = await remainingOf();
    }
  }

  // 收起下拉，避免挡住下面的按钮
  await page.locator('.publish-popup.active .title').first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(400);
  const limit = initialLeft ?? (added.length && added.length < names.length ? added.length : null);
  return { added, limit };
}

/** 需要人工补全时不要关页面，把窗口留给用户操作 */
async function waitForManualPublish(page, reason, timeout = 10 * 60 * 1000) {
  console.log(`! ${reason}`);
  console.log('! 标题、正文、图片、摘要、封面都已填好，请在保留的页面里手动选好标签后点「确定并发布」，或关闭窗口取消。');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (page.isClosed()) return { ok: false, note: '浏览器已关闭，未发布' };
    if (/juejin\.cn\/post\/\d+/.test(page.url())) return { ok: true, url: page.url(), note: '手动发布完成' };
    await page.waitForTimeout(2000);
  }
  return { ok: false, note: '等待手动发布超时（10 分钟）' };
}

async function setCover(page, panel, file) {
  if (!file) return false;
  const input = panel.locator('.coverselector_container input[type=file]').first();
  if (!(await input.count())) return false;
  await input.setInputFiles(file);
  // 未上传时容器里是「+」占位图（add.svg），必须等真正的预览图 preview-image 出现
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const src = await panel
      .locator('.coverselector_container img.preview-image')
      .first()
      .getAttribute('src')
      .catch(() => '');
    if (src && /juejin\.cn/.test(src)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function waitPublishResult(page, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (/juejin\.cn\/post\/\d+/.test(page.url())) return { ok: true, url: page.url() };
    // 只看真正的提示条/校验错误，不扫整页文本（占位文案会误伤）
    let hint = '';
    try {
      hint = await page.evaluate(() => {
        const nodes = [
          ...document.querySelectorAll(
            '.byte-message, .byte-notification, [class*=toast], [class*=error-tip], [class*=error-message]',
          ),
        ]
          .filter((el) => el.getClientRects().length)
          .map((el) => (el.innerText || '').trim())
          .filter(Boolean);
        return nodes.join(' / ').slice(0, 160);
      });
    } catch {
      // 发布成功会跳转，evaluate 期间页面被销毁属于正常情况
      await page.waitForTimeout(1500);
      continue;
    }
    if (/发布成功/.test(hint)) return { ok: true, url: page.url(), note: hint };
    if (/失败|不能为空|请选择|最多/.test(hint)) return { ok: false, note: hint };
    await page.waitForTimeout(1500);
  }
  return { ok: false, note: '等待发布结果超时，请查看截图确认' };
}

/** 掘金摘要要求 50~100 字，文章摘要不够长时用正文补齐 */
function buildSummary(content) {
  const text = content.markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#>*`|~\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${content.digest} ${text}`.trim().slice(0, 100);
}

export default {
  id: 'juejin',
  name: '稀土掘金',
  loginUrl: 'https://juejin.cn/login',
  homeUrl: 'https://juejin.cn/creator/home',
  editorUrl: EDITOR_URL,
  authCookies: ['sessionid'],
  optionsSpec: { category: 'required', tags: 'required', tagsMax: MAX_TAGS, cover: true },

  /** 发布弹窗里做标签候选：空关键词返回热门标签，传词就搜站内标签 */
  async fetchTags({ keyword = '' } = {}) {
    return { tags: await queryTagNames(keyword) };
  },

  async fetchOptions({ headless = true } = {}) {
    const { browser, page } = await openSession('juejin', { headless, url: EDITOR_URL });
    try {
      const panel = await openPublishPanel(page);
      const names = await panel.locator('.category-list .item').allInnerTexts();
      return { categories: names.map((name) => name.trim()).filter(Boolean) };
    } finally {
      await browser.close().catch(() => {});
    }
  },

  async publish(slug, { headless = false, execute = true, options = {} } = {}) {
    const content = await loadContent(slug);
    const chosen = normalizeTags(options.tags);
    const tags = chosen.length ? chosen : content.tags;
    if (!tags.length) throw new Error('掘金至少需要 1 个标签');

    // 摘要 50~100 字是平台硬要求，先校验再开浏览器，免得填到一半才失败
    const summaryText = buildSummary(content);
    if (summaryText.length < 50) {
      throw new Error(`掘金摘要需要 50~100 字，当前只有 ${summaryText.length} 字，请补充正文或 digest`);
    }

    const { browser, page } = await openSession('juejin', {
      headless,
      url: EDITOR_URL,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const dir = await ensureDebugDir('juejin');
    const shots = [];

    try {
      await page.locator(BODY_EDITOR).waitFor({ state: 'visible', timeout: 60000 });
      await page.locator('input.title-input').fill(content.title);

      const urlMap = await uploadImages(page, content.images);
      await setBody(page, replaceImageSources(content.markdown, urlMap));
      await page.waitForTimeout(1500);
      shots.push(await shot(page, dir, 'filled.png'));

      const tagPlan = await resolveTags(tags.slice(0, MAX_TAGS));
      const panel = await openPublishPanel(page);

      // 分类和标签都是必填项，缺一个平台就会拦下；失败时保留页面交给用户手动补
      let category = null;
      let tagResult = { added: [] };
      let blocked = '';
      try {
        category = await pickCategory(page, panel, options.category);
      } catch (error) {
        blocked = error.message;
      }
      if (!blocked) {
        try {
          if (!tagPlan.names.length) blocked = describeMissing(tagPlan);
          else {
            tagResult = await addTags(page, panel, tagPlan.names);
            if (!tagResult.added.length) blocked = `标签没有添加成功（${tagPlan.names.join(' / ')}）`;
          }
        } catch (error) {
          blocked = error.message;
        }
      }

      // 标签没搞定也先把摘要和封面填好，用户只需要补标签
      const summary = panel.locator('textarea').first();
      if (await summary.count()) {
        await summary.fill(summaryText);
      }
      const coverOk = await setCover(page, panel, options.cover || content.cover);

      const notes = [
        category ? `分类：${category.picked}` : '',
        tagResult.added.length
          ? `标签：${tagResult.added.join(' / ')}${
              tagResult.limit !== null && tagResult.limit < tagPlan.names.length
                ? `（平台限制，该账号只能选 ${tagResult.limit} 个）`
                : ''
            }`
          : '',
        tagResult.added.length && tagPlan.missing.length ? describeMissing(tagPlan) : '',
        urlMap.size ? `上传 ${urlMap.size} 张图片` : '',
        coverOk ? '封面已上传' : '',
      ].filter(Boolean);

      if (blocked) {
        notes.push(blocked);
        shots.push(await shot(page, dir, 'manual-required.png'));
        if (!execute) return { ok: true, dry: true, note: notes.join('；'), shots };
        const manual = await waitForManualPublish(page, blocked);
        shots.push(await shot(page, dir, 'manual-done.png'));
        return { ...manual, note: [...notes, manual.note].filter(Boolean).join('；'), shots };
      }

      shots.push(await shot(page, dir, 'publish-panel.png'));

      if (!execute) {
        return { ok: true, dry: true, note: notes.join('；'), shots };
      }

      await panel.locator('button', { hasText: '确定并发布' }).first().click();
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
