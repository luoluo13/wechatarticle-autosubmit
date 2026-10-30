import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { dirs } from './config.js';

export const DEBUG_DIR = path.join(dirs.build, 'debug');

/**
 * 优先用本机真实 Chrome（更接近真人环境，风控概率更低），
 * 没装 Chrome 时退回 Playwright 自带的 Chromium。
 */
export async function launchBrowser({ headless = false } = {}) {
  const base = {
    headless,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  };
  try {
    return await chromium.launch({ ...base, channel: 'chrome' });
  } catch {
    return await chromium.launch(base);
  }
}

/** 每个平台一个登录态文件：auth/<platform>.json（已在 .gitignore 中忽略） */
export function authFile(platformId) {
  return path.join(dirs.auth, `${platformId}.json`);
}

export async function hasAuth(platformId) {
  try {
    await fs.access(authFile(platformId));
    return true;
  } catch {
    return false;
  }
}

export async function readAuth(platformId) {
  try {
    return JSON.parse(await fs.readFile(authFile(platformId), 'utf8'));
  } catch {
    return null;
  }
}

export async function saveAuth(platformId, state) {
  await fs.mkdir(dirs.auth, { recursive: true });
  await fs.writeFile(authFile(platformId), JSON.stringify(state, null, 2), 'utf8');
}

/**
 * 用已保存的登录态开一个会话。登录态缺失时直接报错，
 * 避免每个平台各写一遍「有没有登录」的检查。
 */
export async function openSession(platformId, { headless = false, url, permissions = [] } = {}) {
  const state = await readAuth(platformId);
  if (!state) {
    throw new Error(`还没有 ${platformId} 的登录态，请先执行：node src/cli.js login ${platformId}`);
  }

  const browser = await launchBrowser({ headless });
  const context = await browser.newContext({
    storageState: state,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
  });
  if (permissions.length) await context.grantPermissions(permissions);

  const page = await context.newPage();
  if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { browser, context, page };
}

export async function ensureDebugDir(platformId) {
  const dir = platformId ? path.join(DEBUG_DIR, platformId) : DEBUG_DIR;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function shot(page, dir, name) {
  const file = path.join(dir, name);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}
