import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { root } from './config.js';

export const AUTH_FILE = path.join(root, 'auth.json');
export const DEBUG_DIR = path.join(root, 'build', 'debug');
export const MP_HOME = 'https://mp.weixin.qq.com/';
export const MP_ORIGIN = 'https://mp.weixin.qq.com';

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

export async function readAuth() {
  try {
    const raw = await fs.readFile(AUTH_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveAuth(state) {
  await fs.writeFile(AUTH_FILE, JSON.stringify(state, null, 2), 'utf8');
}

export async function ensureDebugDir() {
  await fs.mkdir(DEBUG_DIR, { recursive: true });
  return DEBUG_DIR;
}

export function tokenFromUrl(url) {
  try {
    return new URL(url).searchParams.get('token');
  } catch {
    return null;
  }
}

export const EDITOR_URL = (token) =>
  `${MP_ORIGIN}/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=10&token=${token}&lang=zh_CN`;

/**
 * 用已保存的登录态开一个会话，并取出本次会话的 token。
 * 公众号后台的 token 在 URL 里，每次登录都会变，不能写死。
 */
export async function openAuthedSession({ headless = false } = {}) {
  const state = await readAuth();
  if (!state) {
    throw new Error('还没有登录态，请先执行：node src/cli.js login');
  }

  const browser = await launchBrowser({ headless });
  const context = await browser.newContext({
    storageState: state,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: MP_ORIGIN });

  const page = await context.newPage();
  await page.goto(MP_HOME, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  if (/\/cgi-bin\/login/.test(page.url())) {
    await browser.close();
    throw new Error('登录态已失效，请重新执行：node src/cli.js login');
  }

  const token = tokenFromUrl(page.url());
  if (!token) {
    await browser.close();
    throw new Error('未能从后台地址取到 token，登录态可能异常，建议重新 login');
  }

  return { browser, context, page, token };
}
