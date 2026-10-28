#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { buildArticle, listArticles } from './build.js';
import { prepareTheme } from './theme.js';
import { DEFAULT_THEME } from './config.js';
import { login } from './login.js';
import { probeEditor, probeCover } from './probe.js';
import { openAuthedSession, tokenFromUrl } from './browser.js';
import { draftArticle, publishArticle } from './publish.js';

const USAGE = `
autosubmit-wechatarticle

本地渲染：
  node src/cli.js build <slug>     渲染单篇文章
  node src/cli.js build --all      渲染 content/ 下所有文章
  node src/cli.js list             列出可用文章
  node src/cli.js theme [name]     仅重新生成微信兼容主题（默认 ${DEFAULT_THEME}）

公众号后台：
  node src/cli.js login            扫码登录并保存登录态（同时抓取编辑器结构）
  node src/cli.js probe            用已保存的登录态重新抓取编辑器结构
  node src/cli.js draft <slug>     把构建产物填进后台并保存为草稿
  node src/cli.js publish <slug>   走「发表」流程（默认只抓弹窗结构不提交，加 --yes 才真发表）

产物（build/<slug>/）：
  article.html   内联样式正文片段，用于粘贴到公众号编辑器
  preview.html   带「复制正文」按钮的预览页，直接用浏览器打开
  meta.json      标题 / 作者 / 摘要 / 封面，供后续自动发布使用
`;

async function runBuild(args) {
  const slugs = args.includes('--all') ? await listArticles() : args.filter((a) => !a.startsWith('-'));
  if (slugs.length === 0) {
    console.error('没有指定文章。用 `node src/cli.js list` 查看可用文章，或加 --all。');
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  for (const slug of slugs) {
    try {
      const result = await buildArticle(slug);
      console.log(`✓ ${slug}`);
      console.log(`  标题：${result.title}`);
      console.log(`  摘要：${result.digest}`);
      console.log(`  大小：${(result.size / 1024).toFixed(1)} KB`);
      console.log(`  产物：${path.relative(process.cwd(), result.outDir)}`);
      for (const w of result.warnings) console.log(`  ! ${w}`);
    } catch (error) {
      failed += 1;
      console.error(`✗ ${slug}`);
      console.error(`  ${error.message.split('\n').join('\n  ')}`);
    }
  }
  if (failed) process.exitCode = 1;
}

async function runTheme(args) {
  const name = args[0] || DEFAULT_THEME;
  const { outPath, stats } = await prepareTheme(name);
  console.log(`✓ 主题 ${name} 已预处理`);
  console.log(`  CSS 变量展开：${stats.vars} 个`);
  console.log(`  移除伪元素规则：${stats.pseudoRules} 条`);
  console.log(`  移除 at-rule：${stats.atRules} 条`);
  console.log(`  移除不安全声明：${stats.decls} 条`);
  console.log(`  产物：${path.relative(process.cwd(), outPath)}`);
}

async function reportProbe(result) {
  console.log(`✓ 编辑器结构已抓取：${path.relative(process.cwd(), result.jsonPath)}`);
  for (const shot of result.shots) {
    console.log(`  截图：${path.relative(process.cwd(), shot)}`);
  }
}

async function runLogin() {
  const { browser, context, page } = await login();
  try {
    const token = tokenFromUrl(page.url());
    if (!token) {
      console.log('! 未能从后台地址取到 token，跳过编辑器结构抓取');
      return;
    }
    const result = await probeEditor(context, token);
    await reportProbe(result);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runProbe() {
  const { browser, context, token } = await openAuthedSession({ headless: false });
  try {
    const result = await probeEditor(context, token);
    await reportProbe(result);
  } finally {
    await browser.close().catch(() => {});
  }
}

function reportDraft(result) {
  console.log(`✓ ${result.slug} 已填入后台并保存为草稿`);
  console.log(`  摘要字段：${result.digestFilled ? '已填写' : '未找到可填写的摘要输入框'}`);
  console.log(`  图片：${result.images.uploaded}/${result.expectedImages} 已上传到微信`);
  if (result.images.pending) console.log(`  ! 还有 ${result.images.pending} 张图片未被编辑器接管`);
  console.log(`  封面：${result.cover.ok ? '已从正文选择' : `失败（${result.cover.reason}）`}`);
  for (const file of result.shots) console.log(`  截图：${path.relative(process.cwd(), file)}`);
}

async function runDraft(args) {
  const slug = args.find((a) => !a.startsWith('-'));
  if (!slug) {
    console.error('用法：node src/cli.js draft <slug>');
    process.exitCode = 1;
    return;
  }
  const headless = args.includes('--headless');
  const result = await draftArticle(slug, { headless });
  reportDraft(result);
}

async function runPublish(args) {
  const slug = args.find((a) => !a.startsWith('-'));
  if (!slug) {
    console.error('用法：node src/cli.js publish <slug> [--yes]');
    process.exitCode = 1;
    return;
  }
  const headless = args.includes('--headless');
  const execute = args.includes('--yes');
  const result = await publishArticle(slug, { headless, execute });
  reportDraft(result);
  const p = result.publish;
  if (!p.executed) {
    console.log(`  发表：未提交（${p.reason}）`);
  } else {
    console.log(`  群发通知：${p.groupSendOff ? '已关闭' : '未关闭（请检查后台）'}`);
    console.log(`  发表：${p.ok ? '成功' : `未确认，请查看截图${p.dialogs.length ? `；弹窗：${p.dialogs.join(' / ')}` : ''}`}`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'build':
      await runBuild(args);
      break;
    case 'list': {
      const slugs = await listArticles();
      if (slugs.length === 0) console.log('content/ 下还没有文章目录。');
      for (const slug of slugs) console.log(slug);
      break;
    }
    case 'theme':
      await runTheme(args);
      break;
    case 'login':
      await runLogin();
      break;
    case 'probe':
      await runProbe();
      break;
    case 'probe-cover': {
      const { browser, context, token } = await openAuthedSession({ headless: false });
      try {
        const result = await probeCover(context, token);
        console.log(`✓ 封面对话框结构：${path.relative(process.cwd(), result.jsonPath)}`);
        console.log(`  截图：${path.relative(process.cwd(), result.shot)}`);
      } finally {
        await browser.close().catch(() => {});
      }
      break;
    }
    case 'draft':
      await runDraft(args);
      break;
    case 'publish':
      await runPublish(args);
      break;
    case undefined:
    case '-h':
    case '--help':
      console.log(USAGE);
      break;
    default:
      console.error(`未知命令：${command}`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
