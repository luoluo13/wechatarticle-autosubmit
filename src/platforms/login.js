import { launchBrowser, saveAuth, readAuth } from '../browser.js';

const LOGIN_TIMEOUT = 5 * 60 * 1000;
const LOGIN_ALL_TIMEOUT = 15 * 60 * 1000;

/**
 * 登录判定：优先用平台自己的 DOM 判断，其次看登录 cookie。
 * 两个都没有的平台（如公众号）必须实现 checkLogin。
 */
async function isLoggedIn(platform, context, page) {
  if (platform.checkLogin) {
    try {
      if (await platform.checkLogin(page)) return true;
    } catch {
      // 页面跳转中，下一轮再判
    }
  }
  if (!platform.authCookies?.length) return false;
  const cookies = await context.cookies();
  return platform.authCookies.some((name) => cookies.some((c) => c.name === name && c.value));
}

function newContext(browser, storageState) {
  return browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
    ...(storageState ? { storageState } : {}),
  });
}

/** 单平台登录：打开登录页，轮询到登录成功即保存登录态并关闭浏览器 */
export async function loginPlatform(platform, { headless = false, timeout = LOGIN_TIMEOUT } = {}) {
  const browser = await launchBrowser({ headless });
  const context = await newContext(browser);
  const page = await context.newPage();
  await page.goto(platform.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log(`请登录 ${platform.name}…（浏览器窗口已打开）`);

  try {
    await waitFor(platform, context, page, timeout);
    await saveAuth(platform.id, await context.storageState());
    console.log(`✓ ${platform.name} 登录成功，登录态已保存`);
    return { ok: true };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * 一次性打开多个平台的登录页（每个平台独立 context，互不串 cookie），
 * 用户逐个登录，登录成功一个就立刻落盘一个。
 */
export async function loginMany(platforms, { timeout = LOGIN_ALL_TIMEOUT } = {}) {
  const browser = await launchBrowser({ headless: false });
  const sessions = [];

  try {
    for (const platform of platforms) {
      // 已有登录态的平台先带上，打开后如果仍然有效就直接判定为已登录
      const context = await newContext(browser, await readAuth(platform.id));
      const page = await context.newPage();
      await page.goto(platform.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      sessions.push({ platform, context, page, saved: false, skipped: false });
    }

    console.log(`已打开 ${sessions.length} 个登录页，请逐个完成登录（最长等待 15 分钟）：`);
    for (const { platform } of sessions) console.log(`  · ${platform.name}`);

    const deadline = Date.now() + timeout;
    while (sessions.some((s) => !s.saved && !s.skipped) && Date.now() < deadline) {
      for (const session of sessions) {
        if (session.saved || session.skipped) continue;
        if (session.page.isClosed()) {
          session.skipped = true;
          console.log(`! ${session.platform.name} 页面已关闭，跳过`);
          continue;
        }
        if (await isLoggedIn(session.platform, session.context, session.page)) {
          await saveAuth(session.platform.id, await session.context.storageState());
          session.saved = true;
          console.log(`✓ ${session.platform.name} 登录成功，登录态已保存`);
        }
      }
      if (sessions.some((s) => !s.saved && !s.skipped)) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    const pending = sessions
      .filter((s) => !s.saved)
      .map((s) => s.platform.name);
    if (pending.length) console.log(`! 以下平台未检测到登录：${pending.join(' / ')}`);

    return {
      saved: sessions.filter((s) => s.saved).map((s) => s.platform.id),
      pending: sessions.filter((s) => !s.saved).map((s) => s.platform.id),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function waitFor(platform, context, page, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await isLoggedIn(platform, context, page)) return;
    if (page.isClosed()) throw new Error('登录页已被关闭，登录取消');
    await page.waitForTimeout(1500);
  }
  throw new Error(`${platform.name} 登录超时（5 分钟），请重新执行 login`);
}
