import wechat from './wechat/index.js';
import csdn from './csdn.js';
import juejin from './juejin.js';
import zhihu from './zhihu.js';
import cnblogs from './cnblogs.js';
import trae from './trae.js';

/** 平台注册表：新增平台只要实现同一套接口后加进这个数组 */
export const PLATFORMS = [wechat, csdn, juejin, zhihu, cnblogs, trae];

export function getPlatform(id) {
  const platform = PLATFORMS.find((item) => item.id === id);
  if (!platform) throw new Error(`未知平台：${id}`);
  return platform;
}
