import fs from 'node:fs/promises';
import path from 'node:path';
import { dirs } from '../../config.js';
import { ensureDebugDir } from '../../browser.js';
import { EDITOR_URL, openAuthedSession } from './session.js';

const TITLE_EDITOR = '.title-editor__input .ProseMirror';
const BODY_EDITOR = '.rich_media_content .ProseMirror';

async function shot(page, dir, name) {
  const file = path.join(dir, name);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}

async function clickButton(page, name) {
  const button = page.getByRole('button', { name, exact: false }).filter({ visible: true }).first();
  await button.waitFor({ state: 'visible', timeout: 15000 });
  await button.click();
}

async function waitForEditor(page) {
  await page.locator(TITLE_EDITOR).waitFor({ state: 'visible', timeout: 30000 });
  await page.locator(BODY_EDITOR).waitFor({ state: 'visible', timeout: 30000 });
}

async function fillMeta(page, meta) {
  // 标题也是 ProseMirror（原生 textarea#title 是隐藏表单字段，填不进去）
  const title = page.locator(TITLE_EDITOR).first();
  await title.click();
  await page.keyboard.insertText(meta.title);

  if (meta.author) {
    const author = page.locator('#author');
    if (await author.count()) {
      await author.click();
      await author.fill(meta.author);
    }
  }

  if (meta.digest) {
    const desc = page.locator('#js_description');
    if (!(await desc.isVisible().catch(() => false))) {
      const settings = page.getByText('文章设置', { exact: true }).filter({ visible: true }).first();
      if (await settings.count()) {
        await settings.click().catch(() => {});
        await page.waitForTimeout(800);
      }
    }
    try {
      await desc.fill(meta.digest, { timeout: 5000 });
    } catch {
      return { digestFilled: false };
    }
  }
  return { digestFilled: true };
}

async function pasteBody(page, html) {
  const editor = page.locator(BODY_EDITOR).first();
  await editor.click();
  await page.waitForTimeout(300);

  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  await page.evaluate(
    async ({ html: htmlContent, plain }) => {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([htmlContent], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        }),
      ]);
    },
    { html, plain: text },
  );

  await page.keyboard.press('Control+V');

  await page.waitForFunction(
    (selector) => {
      const el = document.querySelector(selector);
      return el && el.innerText.trim().length > 20;
    },
    BODY_EDITOR,
    { timeout: 30000 },
  );
}

/** 等 base64 图片被编辑器上传并替换成 mmbiz.qpic.cn 地址 */
async function waitForImages(page, expected, timeout = 90000) {
  if (!expected) return { uploaded: 0, pending: 0, total: 0 };
  try {
    await page.waitForFunction(
      (n) => document.querySelectorAll('img[src*="mmbiz.qpic.cn"]').length >= n,
      expected,
      { timeout },
    );
  } catch {
    // 超时后统一统计
  }
  return page.evaluate(() => {
    const imgs = [...document.querySelectorAll('.rich_media_content img')];
    return {
      uploaded: imgs.filter((el) => /mmbiz\.qpic\.cn/.test(el.src)).length,
      pending: imgs.filter((el) => /^data:/.test(el.src)).length,
      total: imgs.length,
    };
  });
}

/** 在封面弹窗里切到「上传封面」页签并选文件；弹窗没有上传入口时返回 false，退回从正文选 */
async function uploadCover(page, file) {
  const dialog = page.locator('.weui-desktop-dialog_img-picker').filter({ visible: true }).first();
  if (!(await dialog.count().catch(() => 0))) return false;

  const tab = dialog.getByText(/上传封面|上传图片/).filter({ visible: true }).first();
  if (!(await tab.count().catch(() => 0))) return false;
  await tab.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);

  const input = dialog.locator('input[type=file]').first();
  if (!(await input.count().catch(() => 0))) return false;
  await input.setInputFiles(file);
  await page.waitForTimeout(3000);
  return true;
}

/**
 * 选封面：默认取正文第 index 张图片；
 * 传了 upload（本地图片）则走封面上传，本地图片不必出现在正文里。
 * 菜单项在浮层里且有 3 个同 class 副本，必须对「可见的那个」派发 click。
 */
async function setCoverFromBody(page, debugDir, slug, shots, { index = 0, upload = '' } = {}) {
  const placeholder = page.getByText('拖拽或选择封面', { exact: false }).filter({ visible: true }).first();
  await placeholder.click({ timeout: 15000 });
  await page.waitForTimeout(800);

  const dialog = '.weui-desktop-dialog_img-picker';
  const uploaded = upload ? await uploadCover(page, upload) : false;

  if (!uploaded) {
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('.js_selectCoverFromContent')];
      const visible = items.find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      (visible || items[0])?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(2000);
    shots.push(await shot(page, debugDir, `${slug}-5-cover-dialog.png`));

    // 缩略图是带 background-image 的 span，不是 <img>；点 li 的中心最稳
    const itemBox = await page.evaluate(
      ({ sel, order }) => {
        const root = [...document.querySelectorAll(sel)].find((el) =>
          el.querySelector('li.appmsg_content_img_item'),
        );
        if (!root) return null;
        const items = [...root.querySelectorAll('li.appmsg_content_img_item')];
        const target = items[order] || items[0];
        if (!target) return null;
        const box = target.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      },
      { sel: dialog, order: Math.max(0, Number(index) || 0) },
    );
    if (!itemBox) return { ok: false, reason: '正文里没有可用作封面的图片' };

    await page.mouse.click(itemBox.x, itemBox.y);
    await page.waitForTimeout(1000);
  }
  shots.push(await shot(page, debugDir, `${slug}-6-cover-selected.png`));

  const next = page.locator(`${dialog} button`).filter({ hasText: '下一步' }).first();
  const hasNext = await next.count().catch(() => 0);
  const nextDisabled = hasNext
    ? await next.evaluate((el) => /disabled/.test(el.className)).catch(() => true)
    : true;

  // 上传封面后微信可能直接跳到裁剪页，此时「下一步」不存在，不能据此判定失败
  if (hasNext && !nextDisabled) {
    await next.click({ timeout: 8000 }).catch(() => {});
  }

  if (!nextDisabled || uploaded) {

    // 裁剪页是异步加载的：加载中只有一个「上一步」和转圈，必须等预览卡片出来再操作
    const square = page.locator('.cover-preview-card').filter({ hasText: '1:1' }).first();
    const cropReady = await square
      .waitFor({ state: 'visible', timeout: 20000 })
      .then(() => true)
      .catch(() => false);

    if (cropReady) {
      // 「编辑封面」默认停在 2.35:1 面板，1:1 的裁剪框只有切到 1:1 才会生成。
      // 不切换直接确认，微信会把 2.35:1 的结果当成 1:1 上传，
      // 保存草稿时报「1:1 封面规格异常，请重新裁剪」，发表时又会被要求重新裁剪。
      await square.click({ timeout: 8000 }).catch(() => {});
      await square11Ready(page);
    }

    shots.push(await shot(page, debugDir, `${slug}-7-cover-next.png`));

    const done = page
      .getByRole('button', { name: /^(确认|确定|完成)$/ })
      .filter({ visible: true })
      .first();
    const doneVisible = await done
      .waitFor({ state: 'visible', timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    if (doneVisible) {
      await done.click({ timeout: 8000 }).catch(() => {});
    }
  }

  await closeDialogs(page);

  // 封面是异步写入的：确认后编辑器要过一会儿才把占位换成图片，不能立刻判定
  const covered = await page
    .waitForFunction(
      () => {
        const area = document.querySelector('#js_cover_area');
        if (!area) return false;
        const cdn = area.querySelector('input[name="cdn_url"]');
        if (cdn && cdn.value) return true;
        const preview = area.querySelector('.select-cover__preview, .js_cover_preview_new');
        return !!preview && preview.getBoundingClientRect().width > 0;
      },
      null,
      { timeout: 20000 },
    )
    .then(() => true)
    .catch(() => false);

  shots.push(await shot(page, debugDir, `${slug}-8-cover-done.png`));

  // 微信在后台校验 1:1 封面，异常时正文区会挂一条红字，后面点「发表」只会再弹裁剪框
  const specIssue = await page
    .evaluate(() => {
      const text = (document.body.innerText || '').replace(/\s+/g, ' ');
      return (text.match(/[^。\n]{0,10}封面规格异常[^。\n]{0,10}/) || [''])[0];
    })
    .catch(() => '');

  const ok = (uploaded || !nextDisabled) && covered && !specIssue;
  return {
    ok,
    reason: ok
      ? ''
      : !uploaded && nextDisabled
        ? '缩略图点击后「下一步」仍不可用'
        : specIssue || (covered ? '' : '封面未写入'),
  };
}

/** 等 1:1 裁剪框被切出来并变成正方形（切面板前是 2.35:1 的长方形） */
async function square11Ready(page, timeout = 10000) {
  return page
    .waitForFunction(
      () => {
        const tracker = document.querySelector('.cover-crop-con .jcrop-tracker');
        if (!tracker) return false;
        const rect = tracker.getBoundingClientRect();
        return rect.width > 50 && Math.abs(rect.width - rect.height) <= 2;
      },
      null,
      { timeout },
    )
    .then(() => true)
    .catch(() => false);
}

/** 关掉可能还开着的弹层，避免挡住底部按钮 */
async function closeDialogs(page) {
  for (const selector of ['.weui-desktop-dialog_img-picker', '.weui-desktop-dialog']) {
    const dialog = page.locator(selector).filter({ visible: true }).first();
    if (!(await dialog.count())) continue;
    const cancel = dialog.getByRole('button', { name: '取消' }).first();
    if (await cancel.count()) {
      await cancel.click({ timeout: 3000 }).catch(() => {});
    } else {
      await dialog.locator('.weui-desktop-dialog__close-btn').first().click({ timeout: 3000 }).catch(() => {});
    }
    await page.waitForTimeout(800);
  }
}

/**
 * 发表时可能触发「微信验证」扫码框（新环境/异地登录常见）。
 * 弹窗是提交后才异步渲染的，所以要先等它出现，再等用户扫码。
 */
async function waitForScanVerify(page, timeout = 5 * 60 * 1000, appearTimeout = 20000) {
  const marker = page.getByText('扫码后，请联系管理员进行验证', { exact: false });
  const appeared = await marker
    .filter({ visible: true })
    .first()
    .waitFor({ state: 'visible', timeout: appearTimeout })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return { needed: false };

  console.log('! 微信要求验证：请用微信扫描浏览器窗口里的二维码，扫码后会自动继续…');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (!(await marker.filter({ visible: true }).count())) {
      console.log('✓ 验证已通过');
      return { needed: true, verified: true };
    }
  }
  return { needed: true, verified: false };
}

/** 点「发表」→（首次可能先弹创作来源声明）→ 真正的「发表」弹窗；execute=true 时才提交 */
async function openPublishDialog(page, debugDir, slug, shots, execute) {
  await clickButton(page, '发表');
  await page.waitForTimeout(2500);

  // 首次发表会先弹「创作来源声明」，声明与否需人工判断
  const noClaim = page
    .getByRole('button', { name: '无需声明并发表' })
    .filter({ visible: true })
    .first();
  if (await noClaim.count()) {
    if (!execute) {
      await page
        .locator('.claim-source-notice-dialog .weui-desktop-dialog__close-btn')
        .first()
        .click({ timeout: 5000 })
        .catch(() => {});
      return { executed: false, reason: '未加 --yes，已关闭创作来源声明弹窗' };
    }
    await noClaim.click();
    await page.waitForTimeout(2500);
  }

  // 真正的「发表」弹窗：群发通知 / 分组通知 / 定时发表。
  // 必须按「里面有没有发表按钮」来认，不能取第一个 .weui-desktop-dialog：
  // 封面 1:1 无效时，点「发表」弹出的是「编辑封面」，那里面没有发表按钮。
  const dialog = page
    .locator('.weui-desktop-dialog')
    .filter({ has: page.getByRole('button', { name: '发表', exact: true }) })
    .filter({ visible: true })
    .first();

  const dialogAppeared = await dialog
    .waitFor({ timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!dialogAppeared) {
    const cropOpen = await page.locator('.cover-edit-new').filter({ visible: true }).count();
    throw new Error(
      cropOpen
        ? '点「发表」后微信弹出的是「编辑封面」：封面 1:1 裁剪无效，需要重新裁剪后再发表'
        : '点「发表」后没有出现发表弹窗，请查看截图确认后台当前状态',
    );
  }
  await page.waitForTimeout(800);
  shots.push(await shot(page, debugDir, `${slug}-10-publish-dialog.png`));

  if (!execute) {
    await dialog.getByRole('button', { name: '取消' }).first().click({ timeout: 5000 }).catch(() => {});
    return { executed: false, reason: '未加 --yes，已关闭发表弹窗' };
  }

  // 用户要求只发表、不群发：先关掉「群发通知」开关
  const groupInput = page.locator('.mass_send__notify .weui-desktop-switch__input').first();
  let groupSendOff = false;
  if (await groupInput.count()) {
    if (await groupInput.isChecked()) {
      await page.locator('.mass_send__notify .weui-desktop-switch').first().click({ timeout: 5000 });
      await page.waitForTimeout(1000);
    }
    groupSendOff = !(await groupInput.isChecked());
  }

  await dialog
    .getByRole('button', { name: '发表', exact: true })
    .filter({ visible: true })
    .first()
    .click({ timeout: 10000 });

  // 关掉群发通知后会再弹一次「未开启群发通知」确认
  const keepGoing = page.getByRole('button', { name: '继续发表' }).filter({ visible: true }).first();
  const asked = await keepGoing
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (asked) {
    await keepGoing.click({ timeout: 8000 }).catch(() => {});
  }

  const verify = await waitForScanVerify(page);

  // 扫码通过后，提交会继续走到成功提示
  let okByWait = false;
  if (verify.needed && verify.verified) {
    okByWait = await page
      .waitForFunction(() => /发表成功|审核中/.test(document.body.innerText), null, {
        timeout: 60000,
      })
      .then(() => true)
      .catch(() => false);
  }

  await page.waitForTimeout(3000);
  shots.push(await shot(page, debugDir, `${slug}-11-publish-result.png`));

  const state = await page.evaluate(() => ({
    url: location.href,
    text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 800),
    dialogs: [...document.querySelectorAll('.weui-desktop-dialog')]
      .filter((el) => el.getBoundingClientRect().width > 100)
      .map((el) => (el.innerText || '').replace(/\s+/g, ' ').slice(0, 300)),
  }));
  await fs.writeFile(
    path.join(debugDir, 'publish-result.json'),
    JSON.stringify(state, null, 2),
    'utf8',
  );

  return {
    executed: true,
    // 提交成功后后台通常直接跳回首页，这是最可靠的信号
    ok:
      okByWait ||
      /\/cgi-bin\/home\b/.test(state.url) ||
      (!state.dialogs.length && /发表成功/.test(state.text)),
    groupSendOff,
    verify,
    dialogs: state.dialogs,
    url: state.url,
  };
}

export async function draftArticle(slug, options = {}) {
  return runArticle(slug, { ...options, publish: false });
}

/** 填好内容并走「发表」流程；execute=false 时只抓弹窗结构再取消 */
export async function publishArticle(slug, options = {}) {
  return runArticle(slug, { ...options, publish: true });
}

async function runArticle(
  slug,
  { headless = false, publish = false, execute = false, coverIndex = 0, coverFile = '' } = {},
) {
  const outDir = path.join(dirs.build, slug);
  let html;
  let metaRaw;
  try {
    [html, metaRaw] = await Promise.all([
      fs.readFile(path.join(outDir, 'article.html'), 'utf8'),
      fs.readFile(path.join(outDir, 'meta.json'), 'utf8'),
    ]);
  } catch {
    throw new Error(`缺少 ${slug} 的构建产物，请先执行：node src/cli.js build ${slug}`);
  }
  const meta = JSON.parse(metaRaw);
  const expectedImages = (html.match(/<img\b/g) || []).length;

  const { browser, page, token } = await openAuthedSession({ headless });
  const debugDir = await ensureDebugDir();
  const shots = [];

  try {
    await page.goto(EDITOR_URL(token), { waitUntil: 'domcontentloaded' });
    await waitForEditor(page);
    shots.push(await shot(page, debugDir, `${slug}-1-empty.png`));

    const { digestFilled } = await fillMeta(page, meta);
    await pasteBody(page, html);
    await page.waitForTimeout(1500);
    shots.push(await shot(page, debugDir, `${slug}-2-filled.png`));

    const images = await waitForImages(page, expectedImages);

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);
    shots.push(await shot(page, debugDir, `${slug}-3-top.png`));

    let cover;
    try {
      cover = await setCoverFromBody(page, debugDir, slug, shots, {
        index: coverIndex,
        upload: coverFile,
      });
    } catch (error) {
      cover = { ok: false, reason: error.message };
      await closeDialogs(page);
    }

    await clickButton(page, '保存为草稿');
    await page.waitForTimeout(3000);
    shots.push(await shot(page, debugDir, `${slug}-9-saved.png`));

    const result = { slug, digestFilled, images, expectedImages, cover, shots, url: page.url() };
    if (publish) {
      result.publish = await openPublishDialog(page, debugDir, slug, shots, execute);
    }
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}
