import { chat } from './providers.js';
import { getConnection, listTemplates, readSession, writeSession } from './store.js';
import { findTemplate } from './prompts.js';
import { buildChatMessages, buildComposeMessages, estimateCost, extractTitle } from './generate.js';
import { loadArticle } from '../build.js';

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

function pickParams(session, input = {}) {
  return {
    platform: String(input.platform ?? session.platform ?? ''),
    tone: String(input.tone ?? session.params?.tone ?? ''),
    length: String(input.length ?? session.params?.length ?? ''),
    audience: String(input.audience ?? session.params?.audience ?? ''),
    keywords: String(input.keywords ?? session.params?.keywords ?? ''),
    styleSlug: String(input.styleSlug ?? session.params?.styleSlug ?? ''),
    temperature: input.temperature ?? session.params?.temperature ?? '',
    maxTokens: input.maxTokens ?? session.params?.maxTokens ?? '',
  };
}

function autoTitle(mode, text) {
  if (mode === 'compose') return extractTitle(text).slice(0, 40) || '';
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 24);
}

/**
 * 对话流式接口（SSE）：event 依次是 meta / delta / done / error。
 * 生成过程中就把用户消息与回答写回会话，断线也能保留已生成部分。
 */
export async function handleChat(req, res, readJson) {
  const body = await readJson(req);
  res.writeHead(200, SSE_HEADERS);
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let session;
  let connection;
  let template;
  let params;
  let mode;
  let style = null;
  try {
    session = await readSession(body.sessionId);
    connection = await getConnection(body.connectionId || session.connectionId);
    if (!connection) throw new Error('还没有可用的模型连接，先在右侧新建并保存一个');
    const templates = await listTemplates();
    template = body.templateId ? findTemplate(templates, body.templateId) : null;
    params = pickParams(session, body.params || {});
    mode = body.mode === 'compose' ? 'compose' : 'chat';
    if (params.styleSlug) {
      if (!SLUG_RE.test(params.styleSlug)) throw new Error('文笔参考的稿件标识不合法');
      try {
        const article = await loadArticle(params.styleSlug);
        style = { title: article.fields.title || params.styleSlug, markdown: article.markdown };
      } catch {
        // 稿件被删掉或改名时退回不参考文笔
        params.styleSlug = '';
      }
    }
    if (mode === 'chat' && !String(body.message || '').trim()) {
      throw new Error('请输入内容');
    }
    if (
      mode === 'compose' &&
      !session.messages.length &&
      !String(body.draft || session.draft || '').trim() &&
      !String(body.message || '').trim()
    ) {
      throw new Error('还没有讨论内容：先聊几句，或填好主题直接生成');
    }
  } catch (error) {
    send('error', { message: error.message });
    res.end();
    return;
  }

  const userText = String(body.message || '').trim();
  if (mode === 'compose' && userText && !session.messages.length) {
    // 直接点「整理成文章」时，把输入框里的主题当作唯一素材
    session.messages.push({ role: 'user', content: userText, at: new Date().toISOString() });
  }

  session.connectionId = connection.id;
  session.templateId = template?.id || '';
  session.platform = params.platform;
  session.params = { ...session.params, ...params };

  send('meta', { mode, model: connection.model, connection: connection.name });

  const messages =
    mode === 'compose'
      ? buildComposeMessages({
          session,
          template,
          params,
          style,
          draft: String(body.draft || session.draft || ''),
        })
      : buildChatMessages({ session, template, params, style, userMessage: userText });

  // 对话场景在拼完上下文后再落盘，避免本轮提问在上下文里出现两次
  if (mode === 'chat') {
    session.messages.push({ role: 'user', content: userText, at: new Date().toISOString() });
  }

  let text = '';
  let usage = null;
  let failure = '';
  try {
    const result = await chat({
      connection,
      messages,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
      signal: controller.signal,
      onDelta: (delta) => {
        text += delta;
        send('delta', { text: delta });
      },
    });
    text = result.text || text;
    usage = result.usage;
  } catch (error) {
    failure = error?.name === 'AbortError' ? '已停止生成' : error.message;
  }

  if (text.trim()) {
    session.messages.push({
      role: 'assistant',
      content: text,
      mode,
      at: new Date().toISOString(),
    });
    if (mode === 'compose') session.draft = text;
    if (!session.title || session.title === '未命名会话') {
      session.title = autoTitle(mode, mode === 'compose' ? text : userText) || session.title;
    }
  }
  if (usage) {
    session.usage = {
      input: (session.usage?.input || 0) + (usage.input || 0),
      output: (session.usage?.output || 0) + (usage.output || 0),
    };
  }
  session.updatedAt = new Date().toISOString();
  await writeSession(session);

  if (failure) {
    send('error', { message: failure, partial: text, usage });
    res.end();
    return;
  }

  send('done', {
    text,
    usage,
    totalUsage: session.usage,
    cost: estimateCost(usage, connection),
    session: { id: session.id, title: session.title, draft: session.draft, updatedAt: session.updatedAt },
  });
  res.end();
}
