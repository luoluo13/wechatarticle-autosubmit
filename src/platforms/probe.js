import fs from 'node:fs/promises';
import path from 'node:path';
import { openSession, ensureDebugDir, shot } from '../browser.js';

const MAX_TEXT = 1500;

/**
 * 通用探针：用已保存的登录态打开平台编辑器，抓一份 DOM 结构与截图。
 * 平台改版导致选择器失效时，先跑它再改对应模块。
 */
export async function probePlatform(platform, { url, headless = false, wait = 3500 } = {}) {
  const target = url || platform.editorUrl || platform.homeUrl;
  const { browser, page } = await openSession(platform.id, { headless, url: target });
  const dir = await ensureDebugDir(platform.id);

  try {
    await page.waitForTimeout(wait);

    const viewport = await shot(page, dir, 'probe-viewport.png');
    const full = path.join(dir, 'probe-full.png');
    await page.screenshot({ path: full, fullPage: true }).catch(() => {});

    const report = await page.evaluate((maxText) => {
      const brief = (el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        cls: String(el.className || '').slice(0, 120),
        name: el.getAttribute('name') || '',
        type: el.getAttribute('type') || '',
        placeholder: el.getAttribute('placeholder') || '',
        contenteditable: el.getAttribute('contenteditable') || '',
        text: (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 60),
      });
      const all = (selector) => [...document.querySelectorAll(selector)];

      return {
        url: location.href,
        title: document.title,
        inputs: all('input, textarea').map(brief),
        editables: all(
          '[contenteditable="true"], .ProseMirror, .CodeMirror, .cm-editor, .monaco-editor',
        ).map(brief),
        selects: all('select').map((el) => ({
          ...brief(el),
          options: [...el.options].map((option) => option.text.slice(0, 30)),
        })),
        buttons: all('button, [role="button"], a.btn, .btn')
          .filter((el) => (el.innerText || '').trim())
          .map(brief)
          .slice(0, 120),
        iframes: all('iframe').map((el) => ({ src: el.getAttribute('src') || '' })),
        bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, maxText),
      };
    }, MAX_TEXT);

    report.frames = page.frames().map((frame) => frame.url());

    const jsonPath = path.join(dir, 'probe.json');
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    return { jsonPath, shots: [viewport, full], url: report.url };
  } finally {
    await browser.close().catch(() => {});
  }
}
