import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dirs } from '../config.js';
import { CHAT_SYSTEM, COMPOSE_SYSTEM, composePrompt, contextBlock, styleBlock } from './prompts.js';

/** 粗略的上下文预算：按字符算，中文约 1 字 1 token，英文约 4 字符 1 token */
const MESSAGE_BUDGET = 24000;

function trimHistory(messages, budget = MESSAGE_BUDGET) {
  const kept = [];
  let size = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const length = String(message.content || '').length;
    if (size + length > budget && kept.length) break;
    size += length;
    kept.unshift(message);
  }
  return kept;
}

/** 对话阶段的消息：通用写作人设 + 选中模板 + 平台等上下文 + 文笔参考 + 历史 */
export function buildChatMessages({ session, template, params = {}, style = null, userMessage }) {
  const system = [CHAT_SYSTEM, template?.system, contextBlock(params), styleBlock(style)]
    .filter(Boolean)
    .join('\n\n');
  const history = trimHistory(session.messages || []).map((message) => ({
    role: message.role,
    content: message.content,
  }));
  return [{ role: 'system', content: system }, ...history, { role: 'user', content: String(userMessage) }];
}

/** 成文阶段：把讨论记录整理成文章 */
export function buildComposeMessages({ session, template, params = {}, style = null, draft = '' }) {
  const system = [COMPOSE_SYSTEM, template?.system, styleBlock(style)].filter(Boolean).join('\n\n');
  const transcript = (session.messages || [])
    .map((message) => `${message.role === 'assistant' ? '助手' : '作者'}：${message.content}`)
    .join('\n\n');
  const extra = draft
    ? `下面是上一版草稿，请在保留作者观点的基础上改进：\n---\n${draft}\n---`
    : '';
  return [
    { role: 'system', content: system },
    { role: 'user', content: composePrompt({ ...params, transcript }) },
    ...(extra ? [{ role: 'user', content: extra }] : []),
  ];
}

/** 从 Markdown 里取一级标题当文章标题 */
export function extractTitle(markdown) {
  const match = String(markdown || '').match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

/** 把标题转成 slug：保留英文数字，其余用日期兜底 */
export function slugFromTitle(title) {
  const ascii = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (ascii.length >= 3) return ascii;
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');
  return `studio-${stamp}-${randomUUID().slice(0, 4)}`;
}

/** 把成稿写成一篇新稿件，结构与发布台「新建」一致 */
export async function importArticle({ markdown, title, slug, fields = {} }) {
  const value = String(slug || '').trim() || slugFromTitle(title);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error('slug 只能包含字母、数字、点、下划线和短横线');
  }
  const dir = path.join(dirs.content, value);
  try {
    await fs.access(dir);
    throw new Error(`稿件 ${value} 已经存在，换个 slug 再导入`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dir, 'index.md'), String(markdown || ''), 'utf8');
  await fs.writeFile(
    path.join(dir, 'article.json'),
    JSON.stringify(
      {
        title: String(title || '').trim() || value,
        ...(fields.author ? { author: fields.author } : {}),
        ...(fields.digest ? { digest: fields.digest } : {}),
        ...(fields.tags ? { tags: fields.tags } : {}),
      },
      null,
      2,
    ),
    'utf8',
  );
  return { slug: value };
}

/** 按连接里填的单价估算费用（元 / 美元由用户自己填的单位决定） */
export function estimateCost(usage, connection) {
  if (!usage || !connection) return 0;
  const inPrice = Number(connection.priceIn) || 0;
  const outPrice = Number(connection.priceOut) || 0;
  return (usage.input / 1e6) * inPrice + (usage.output / 1e6) * outPrice;
}
