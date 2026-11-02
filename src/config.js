import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const dirs = {
  content: path.join(root, 'content'),
  themes: path.join(root, 'themes'),
  userThemes: path.join(root, 'data', 'themes'),
  build: path.join(root, 'build'),
  auth: path.join(root, 'auth'),
  studio: path.join(root, 'data', 'studio'),
};

/** 各平台默认主题；不在这里的平台代表该平台使用自身排版，主题不生效 */
export const DEFAULT_THEMES = {
  wechat: 'orange-heart',
  zhihu: 'zhihu-classic',
};
