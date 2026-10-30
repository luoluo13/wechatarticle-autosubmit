import { openSession } from '../../browser.js';

export const MP_HOME = 'https://mp.weixin.qq.com/';
export const MP_ORIGIN = 'https://mp.weixin.qq.com';

/** 公众号后台的 token 在 URL 里，每次登录都会变，不能写死 */
export const EDITOR_URL = (token) =>
  `${MP_ORIGIN}/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=10&token=${token}&lang=zh_CN`;

export function tokenFromUrl(url) {
  try {
    return new URL(url).searchParams.get('token');
  } catch {
    return null;
  }
}

/**
 * 用已保存的登录态开一个会话，并取出本次会话的 token。
 */
export async function openAuthedSession({ headless = false } = {}) {
  const session = await openSession('wechat', {
    headless,
    url: MP_HOME,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const { browser, page } = session;

  await page.waitForTimeout(2000);

  if (/\/cgi-bin\/login/.test(page.url())) {
    await browser.close();
    throw new Error('登录态已失效，请重新执行：node src/cli.js login wechat');
  }

  const token = tokenFromUrl(page.url());
  if (!token) {
    await browser.close();
    throw new Error('未能从后台地址取到 token，登录态可能异常，建议重新 login');
  }

  return { ...session, token };
}
