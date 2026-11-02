import fs from 'node:fs/promises';

/** 文件 / 目录是否存在（统一各处的重复实现） */
export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
