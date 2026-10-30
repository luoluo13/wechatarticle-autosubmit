#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { buildArticle, listArticles } from './build.js';
import { prepareTheme } from './theme.js';
import { DEFAULT_THEME } from './config.js';
import { openSession } from './browser.js';
import { PLATFORMS, getPlatform } from './platforms/index.js';
import { loginPlatform, loginMany } from './platforms/login.js';
import { probePlatform } from './platforms/probe.js';
import { normalizeTags } from './platforms/shared.js';
import { probeEditor, probeCover } from './platforms/wechat/probe.js';
import { openAuthedSession } from './platforms/wechat/session.js';

const PLATFORM_IDS = PLATFORMS.map((platform) => platform.id).join(' / ');

const USAGE = `
autosubmit-wechatarticle

本地渲染：
  node src/cli.js build <slug>          渲染单篇文章
  node src/cli.js build --all           渲染 content/ 下所有文章
  node src/cli.js list                  列出可用文章
  node src/cli.js theme [name]          仅重新生成微信兼容主题（默认 ${DEFAULT_THEME}）

平台（${PLATFORM_IDS}）：
  node src/cli.js login <platform>      登录单个平台并保存登录态
  node src/cli.js login --all           一次性打开全部平台登录页
  node src/cli.js publish <slug> --platform <id> [--yes] [--dry] [--category x] [--tags a,b]
                                        发布到指定平台（微信需 --yes；其他平台默认直接发布）
  node src/cli.js draft <slug>          微信专用：填入后台并保存为草稿
  node src/cli.js open <platform>       打开平台后台窗口（看数据、管理文章）
  node src/cli.js probe <platform> [url] 抓取平台页面结构，校准选择器
  node src/cli.js probe-cover           微信专用：抓取封面对话框结构

产物（build/<slug>/）：
  article.html   内联样式正文片段，用于粘贴到公众号编辑器
  preview.html   带「复制正文」按钮的预览页，直接用浏览器打开
  meta.json      标题 / 作者 / 摘要 / 封面，供后续自动发布使用
`;

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split('=');
    if (inline !== undefined) {
      flags[key] = inline;
    } else if (args[index + 1] && !args[index + 1].startsWith('--')) {
      flags[key] = args[index + 1];
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

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

function requirePlatform(id) {
  if (!id) {
    console.error(`请指定平台：${PLATFORM_IDS}`);
    process.exitCode = 1;
    return null;
  }
  return getPlatform(id);
}

async function runLogin(args) {
  if (args.includes('--all')) {
    await loginMany(PLATFORMS);
    return;
  }
  const platform = requirePlatform(args.find((arg) => !arg.startsWith('-')));
  if (!platform) return;
  if (platform.login) {
    await platform.login({ headless: false });
  } else {
    await loginPlatform(platform);
  }
}

async function runOpen(args) {
  const platform = requirePlatform(args.find((arg) => !arg.startsWith('-')));
  if (!platform) return;

  const { browser } = await openSession(platform.id, {
    headless: false,
    url: platform.homeUrl,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  console.log(`已打开 ${platform.name} 后台：${platform.homeUrl}`);
  console.log('关闭浏览器窗口即结束。');
  await new Promise((resolve) => browser.on('disconnected', resolve));
}

async function runProbe(args) {
  const { positional, flags } = parseArgs(args);
  const platform = requirePlatform(positional[0] || 'wechat');
  if (!platform) return;

  if (platform.id === 'wechat') {
    const { browser, context, token } = await openAuthedSession({ headless: false });
    try {
      const result = await probeEditor(context, token);
      reportProbe(result);
    } finally {
      await browser.close().catch(() => {});
    }
    return;
  }

  const result = await probePlatform(platform, {
    url: positional[1] || flags.url,
    headless: Boolean(flags.headless),
  });
  reportProbe(result);
}

function reportProbe(result) {
  console.log(`✓ 页面结构已抓取：${path.relative(process.cwd(), result.jsonPath)}`);
  for (const shot of result.shots) {
    console.log(`  截图：${path.relative(process.cwd(), shot)}`);
  }
}

async function runProbeCover() {
  const { browser, context, token } = await openAuthedSession({ headless: false });
  try {
    const result = await probeCover(context, token);
    console.log(`✓ 封面对话框结构：${path.relative(process.cwd(), result.jsonPath)}`);
    console.log(`  截图：${path.relative(process.cwd(), result.shot)}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

function reportWechat(result) {
  console.log(`✓ ${result.slug} 已填入后台`);
  console.log(`  摘要字段：${result.digestFilled ? '已填写' : '未找到可填写的摘要输入框'}`);
  console.log(`  图片：${result.images.uploaded}/${result.expectedImages} 已上传到微信`);
  if (result.images.pending) console.log(`  ! 还有 ${result.images.pending} 张图片未被编辑器接管`);
  console.log(`  封面：${result.cover.ok ? '已从正文选择' : `失败（${result.cover.reason}）`}`);
  for (const file of result.shots) console.log(`  截图：${path.relative(process.cwd(), file)}`);

  const publish = result.publish;
  if (!publish) return;
  if (!publish.executed) {
    console.log(`  发表：未提交（${publish.reason}）`);
    return;
  }
  console.log(`  群发通知：${publish.groupSendOff ? '已关闭' : '未关闭（请检查后台）'}`);
  console.log(
    `  发表：${publish.ok ? '成功' : `未确认，请查看截图${publish.dialogs.length ? `；弹窗：${publish.dialogs.join(' / ')}` : ''}`}`,
  );
}

async function runDraft(args) {
  const { positional, flags } = parseArgs(args);
  const slug = positional[0];
  if (!slug) {
    console.error('用法：node src/cli.js draft <slug>');
    process.exitCode = 1;
    return;
  }
  const platform = getPlatform('wechat');
  reportWechat(await platform.draft(slug, { headless: Boolean(flags.headless) }));
}

async function runPublish(args) {
  const { positional, flags } = parseArgs(args);
  const slug = positional[0];
  if (!slug) {
    console.error('用法：node src/cli.js publish <slug> --platform <id> [--yes] [--dry]');
    process.exitCode = 1;
    return;
  }

  const platform = requirePlatform(flags.platform || 'wechat');
  if (!platform) return;

  const headless = Boolean(flags.headless);
  const options = {
    category: typeof flags.category === 'string' ? flags.category : '',
    tags: typeof flags.tags === 'string' ? normalizeTags(flags.tags) : [],
  };

  const result = await platform.publish(slug, {
    headless,
    execute: platform.id === 'wechat' ? Boolean(flags.yes) : !flags.dry,
    options,
  });

  if (platform.id === 'wechat') {
    reportWechat(result);
    return;
  }

  if (result.dry) {
    console.log(`· ${platform.name} 已填好发布表单，未提交`);
  } else {
    console.log(`${result.ok ? '✓' : '·'} ${platform.name} ${result.ok ? '发布成功' : '未确认发布'}`);
  }
  if (result.url) console.log(`  链接：${result.url}`);
  if (result.note) console.log(`  说明：${result.note}`);
  for (const file of result.shots || []) console.log(`  截图：${path.relative(process.cwd(), file)}`);
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
      await runLogin(args);
      break;
    case 'open':
      await runOpen(args);
      break;
    case 'probe':
      await runProbe(args);
      break;
    case 'probe-cover':
      await runProbeCover();
      break;
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
