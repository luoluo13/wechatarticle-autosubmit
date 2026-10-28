import fs from 'node:fs/promises';
import path from 'node:path';
import { EDITOR_URL, ensureDebugDir, tokenFromUrl } from './browser.js';

/**
 * 封面探针：点开「拖拽或选择封面」，抓取封面选择对话框的结构。
 */
export async function probeCover(context, token) {
  const debugDir = await ensureDebugDir();
  const page = await context.newPage();

  await page.goto(EDITOR_URL(token), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);

  await page.getByText('拖拽或选择封面', { exact: false }).first().click({ timeout: 15000 });
  await page.waitForTimeout(800);

  // 菜单项在浮层里（页面上有 3 个同 class 的副本），直接对可见那个派发 click
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.js_selectCoverFromContent')];
    const visible = items.find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    (visible || items[0])?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(2500);

  const shot = path.join(debugDir, 'cover-dialog.png');
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});

  const report = await page.evaluate(() => {
    const text = (el) => (el.innerText || '').trim().replace(/\s+/g, ' ');
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 10 && r.height > 10;
    };
    return {
      dialogs: [...document.querySelectorAll('.weui-desktop-dialog, [class*="dialog"]')]
        .filter(visible)
        .map((el) => ({
          cls: String(el.className).slice(0, 120),
          text: text(el).slice(0, 400),
        })),
      tabs: [...document.querySelectorAll('[class*="tab"]')]
        .filter(visible)
        .map((el) => ({ cls: String(el.className).slice(0, 80), text: text(el).slice(0, 30) }))
        .slice(0, 40),
      buttons: [...document.querySelectorAll('button, .weui-desktop-btn')]
        .filter(visible)
        .map((el) => text(el))
        .filter(Boolean)
        .slice(0, 40),
      fileInputs: [...document.querySelectorAll('input[type=file]')].map((el) => ({
        accept: el.getAttribute('accept') || '',
        cls: String(el.className).slice(0, 80),
      })),
      images: [...document.querySelectorAll('.weui-desktop-dialog img')]
        .filter(visible)
        .map((el) => ({ cls: String(el.className).slice(0, 60), src: el.src.slice(0, 80) }))
        .slice(0, 20),
    };
  });

  const jsonPath = path.join(debugDir, 'cover-report.json');
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await page.close().catch(() => {});

  return { shot, jsonPath };
}

/**
 * 探针：打开「新建图文」页面，把真实 DOM 结构抓下来。
 * 用途是校准选择器——公众号后台的编辑器改版频繁，靠猜必错。
 */
export async function probeEditor(context, token) {
  const debugDir = await ensureDebugDir();
  const page = await context.newPage();

  const url = EDITOR_URL(token);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  const viewportShot = path.join(debugDir, 'editor-viewport.png');
  const fullShot = path.join(debugDir, 'editor-full.png');
  await page.screenshot({ path: viewportShot, fullPage: false }).catch(() => {});
  await page.screenshot({ path: fullShot, fullPage: true }).catch(() => {});

  const report = await page.evaluate(() => {
    const brief = (el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      cls: String(el.className || '').slice(0, 120),
      name: el.getAttribute('name') || '',
      placeholder: el.getAttribute('placeholder') || '',
      text: (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40),
    });

    const all = (selector) => [...document.querySelectorAll(selector)];

    return {
      url: location.href,
      title: document.title,
      inputs: all('input, textarea').map(brief),
      visibleFields: all('input, textarea')
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
        })
        .map((el) => ({ ...brief(el), rect: el.getBoundingClientRect().toJSON() })),
      proseMirrors: all('div.ProseMirror').map((el) => {
        const r = el.getBoundingClientRect();
        return {
          rect: { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) },
          dataPlaceholder: el.getAttribute('data-placeholder') || '',
          parentCls: String(el.parentElement?.className || '').slice(0, 100),
          innerHTML: el.innerHTML.slice(0, 240),
        };
      }),
      editables: all('[contenteditable="true"]').map(brief),
      iframes: all('iframe').map((el) => ({
        ...brief(el),
        src: el.getAttribute('src') || '',
      })),
      buttons: all('button, a.weui-desktop-btn, .weui-desktop-btn')
        .filter((el) => el.innerText && el.innerText.trim())
        .map(brief)
        .slice(0, 100),
      bodyTextSample: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
    };
  });

  const frames = page.frames().map((frame) => ({ url: frame.url() }));
  report.frames = frames;

  const jsonPath = path.join(debugDir, 'editor-report.json');
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  await page.close().catch(() => {});

  return {
    jsonPath,
    shots: [viewportShot, fullShot],
    url: report.url,
    token: tokenFromUrl(report.url) || token,
  };
}
