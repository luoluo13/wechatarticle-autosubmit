import fs from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import { dirs, DEFAULT_THEME } from './config.js';

/**
 * 伪元素 / 交互伪类在微信里无法生效（内联样式表达不了，<style> 又会被剥离）。
 * 含这些选择器的整条规则直接丢弃。
 */
const DROP_SELECTOR = /::?(before|after|hover|active|focus|focus-within|visited|first-line|first-letter|selection|marker|placeholder|backdrop)\b/i;

/** 微信编辑器不支持（或极易被清洗）的声明 */
const DROP_PROP = new Set([
  'position', 'top', 'right', 'bottom', 'left', 'z-index',
  'float', 'clear',
  'animation', 'animation-name', 'animation-duration', 'transition',
  'transform', 'filter', 'backdrop-filter',
  'display', 'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
  'justify-content', 'align-items', 'align-content', 'align-self', 'order', 'gap',
  'grid', 'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
  'aspect-ratio', 'object-fit', 'object-position', 'inset', 'contain', 'will-change',
]);

const DROP_AT_RULE = new Set(['media', 'supports', 'keyframes', '-webkit-keyframes', 'container', 'layer']);

function isUnsafeDecl(prop, value) {
  const p = prop.toLowerCase().trim();
  const v = String(value).toLowerCase();
  if (p.startsWith('--')) return false;
  if (/^-(webkit|moz|ms|o)-/.test(p)) return true;
  if (DROP_PROP.has(p)) {
    // display 只允许 block / inline / inline-block / none 这类安全值
    if (p === 'display') return !/^(block|inline|inline-block|none|table|table-row|table-cell|list-item)$/.test(v.trim());
    return true;
  }
  if (p.startsWith('flex-') || p.startsWith('grid-')) return true;
  return false;
}

function resolveValue(value, vars, depth = 0) {
  if (depth > 12 || !value.includes('var(')) return value;
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (match, name, fallback) => {
    if (vars.has(name)) return resolveValue(vars.get(name), vars, depth + 1);
    return fallback !== undefined ? fallback.trim() : '';
  });
}

/**
 * 把「网页版主题」转成「微信可用主题」：
 *   1. 收集并展开 CSS 变量为字面值
 *   2. 丢弃伪元素 / 交互伪类规则
 *   3. 丢弃 flex / grid / position / 动画等不安全声明
 *   4. 丢弃 @media 等 at-rule
 */
export async function prepareTheme(name = DEFAULT_THEME) {
  const srcPath = path.join(dirs.themes, `${name}.css`);
  const outPath = path.join(dirs.themes, `${name}.wechat.css`);

  let source;
  try {
    source = await fs.readFile(srcPath, 'utf8');
  } catch {
    throw new Error(`主题不存在：${srcPath}`);
  }

  const rootNode = postcss.parse(source);

  // 1. 收集变量
  const vars = new Map();
  rootNode.walkDecls((decl) => {
    if (decl.prop.startsWith('--')) vars.set(decl.prop.trim(), decl.value.trim());
  });

  const stats = { vars: vars.size, pseudoRules: 0, atRules: 0, decls: 0 };

  // 2. at-rule
  rootNode.walkAtRules((rule) => {
    if (DROP_AT_RULE.has(rule.name.toLowerCase())) {
      stats.atRules += 1;
      rule.remove();
    }
  });

  // 3. 选择器
  rootNode.walkRules((rule) => {
    if (DROP_SELECTOR.test(rule.selector)) {
      stats.pseudoRules += 1;
      rule.remove();
      return;
    }
    if (/^:root$/i.test(rule.selector.trim())) {
      rule.remove();
    }
  });

  // 4. 声明
  rootNode.walkDecls((decl) => {
    if (decl.prop.startsWith('--')) {
      decl.remove();
      return;
    }
    if (decl.value.includes('var(')) decl.value = resolveValue(decl.value, vars);
    if (isUnsafeDecl(decl.prop, decl.value)) {
      stats.decls += 1;
      decl.remove();
      return;
    }
    if (/var\(/.test(decl.value)) {
      // 展开失败（变量缺失）的声明同样丢弃，避免把 var() 带进微信
      stats.decls += 1;
      decl.remove();
    }
  });

  // 5. 清掉因移除声明而变空的规则
  rootNode.walkRules((rule) => {
    if (!rule.nodes || rule.nodes.length === 0) rule.remove();
  });

  const css = rootNode.toString().trim();
  const banner = `/* AUTO-GENERATED from ${name}.css — do not edit. */\n`;
  await fs.writeFile(outPath, banner + css + '\n', 'utf8');

  return { css, outPath, stats };
}
