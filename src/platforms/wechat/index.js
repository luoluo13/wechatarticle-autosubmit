import path from 'node:path';
import { login as loginWechat } from './login.js';
import { draftArticle, publishArticle } from './editor.js';
import { probeEditor } from './probe.js';
import { MP_HOME, tokenFromUrl } from './session.js';
import { loadContent } from '../shared.js';

/**
 * 微信封面只能从正文图片里选（或者走弹窗里的「上传封面」）。
 * 用户选的封面若正好是正文图片，就换算成图片序号；否则把文件交给上传入口。
 */
async function coverArgs(slug, options = {}) {
  if (!options.cover) return { coverIndex: 0, coverFile: '' };
  const content = await loadContent(slug);
  const index = content.images.findIndex(
    (image) => path.resolve(image.file) === path.resolve(options.cover),
  );
  return index >= 0 ? { coverIndex: index, coverFile: '' } : { coverIndex: 0, coverFile: options.cover };
}

/**
 * 微信公众号：走「保存草稿 + 发表」两段式，
 * 发表弹窗里关闭群发通知，只发文章不动粉丝。
 */
export default {
  id: 'wechat',
  name: '微信公众号',
  loginUrl: MP_HOME,
  homeUrl: MP_HOME,
  optionsSpec: { category: false, tags: false, cover: 'body' },

  /** 供「一次性登录全部平台」轮询用 */
  checkLogin: async (page) =>
    /\/cgi-bin\/home\b/.test(page.url()) && /token=\d+/.test(page.url()),

  async login() {
    const { browser, context, page } = await loginWechat();
    try {
      const token = tokenFromUrl(page.url());
      if (token) {
        const result = await probeEditor(context, token);
        console.log(`✓ 编辑器结构：${result.jsonPath}`);
      }
    } catch (error) {
      console.log(`! 编辑器结构抓取失败：${error.message}`);
    } finally {
      await browser.close().catch(() => {});
    }
    return { ok: true };
  },

  async draft(slug, options = {}) {
    return draftArticle(slug, { ...options, ...(await coverArgs(slug, options)) });
  },

  async publish(slug, options = {}) {
    return publishArticle(slug, { ...options, ...(await coverArgs(slug, options)) });
  },
};
