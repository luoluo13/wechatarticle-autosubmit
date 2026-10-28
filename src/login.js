import path from 'node:path';
import {
  launchBrowser,
  saveAuth,
  MP_HOME,
  MP_ORIGIN,
  ensureDebugDir,
  tokenFromUrl,
} from './browser.js';

const LOGIN_TIMEOUT = 5 * 60 * 1000;

/**
 * 打开公众号后台，等用户扫码，成功后保存登录态。
 * 返回 context，供后续探针复用同一个已登录会话。
 */
export async function login() {
  const browser = await launchBrowser({ headless: false });
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: MP_ORIGIN });

  const page = await context.newPage();
  await page.goto(MP_HOME, { waitUntil: 'domcontentloaded' });

  console.log('浏览器窗口已打开，请在 5 分钟内用微信扫码登录公众号后台…');

  try {
    await waitForLoggedIn(page, LOGIN_TIMEOUT);
  } catch (error) {
    const debugDir = await ensureDebugDir();
    await page.screenshot({ path: path.join(debugDir, 'login-timeout.png') }).catch(() => {});
    await browser.close();
    throw error;
  }

  await page.waitForTimeout(2500);

  const account = await readAccountName(page);
  const state = await context.storageState();
  await saveAuth(state);

  const debugDir = await ensureDebugDir();
  const shot = path.join(debugDir, 'login-home.png');
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});

  console.log(`✓ 登录成功${account ? `（${account}）` : ''}`);
  console.log(`✓ 登录态已保存，主页截图：${path.relative(process.cwd(), shot)}`);

  return { browser, context, page, account };
}

/**
 * 登录页会经历 302 跳转链（首页 → home → 又弹回登录页），
 * 所以不能只用 waitForURL，必须轮询到「带数字 token 的 home 地址」出现。
 */
async function waitForLoggedIn(page, timeout) {
  const deadline = Date.now() + timeout;
  let handledAccountPicker = false;

  while (Date.now() < deadline) {
    const url = page.url();
    if (/\/cgi-bin\/home\b/.test(url) && /token=\d+/.test(url)) return;

    // 一个微信号绑定了多个公众号时会先出现账号选择页
    if (!handledAccountPicker && /\/cgi-bin\/(multiple|token)/.test(url)) {
      handledAccountPicker = true;
      const entry = page
        .locator('.weui-desktop-account__item, .account_item, a[href*="cgi-bin/home"]')
        .first();
      if (await entry.count().catch(() => 0)) {
        await entry.click({ timeout: 3000 }).catch(() => {});
      }
    }

    await page.waitForTimeout(1000);
  }

  throw new Error('扫码超时（5 分钟）。请重新执行 login。');
}

export async function readAccountName(page) {
  const candidates = [
    '.weui-desktop-account__nickname',
    '.account_name',
    '.weui-desktop-account__name',
    '.nickname',
  ];
  for (const selector of candidates) {
    try {
      const text = (await page.locator(selector).first().innerText({ timeout: 1500 })).trim();
      if (text) return text;
    } catch {
      // 换下一个选择器
    }
  }
  return '';
}
