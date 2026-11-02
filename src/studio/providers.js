import { randomUUID } from 'node:crypto';

/**
 * 创作间的协议适配层：把「连接配置 + 消息」翻译成各家接口的请求，
 * 再把响应统一成 { text, usage }。所有实现都基于 Node 自带 fetch，不引第三方 SDK。
 */

export const PROTOCOLS = [
  {
    id: 'openai-chat',
    name: 'OpenAI Chat Completions',
    hint: '兼容 OpenAI、DeepSeek、月之暗面、智谱、通义、硅基流动、OpenRouter、Groq、xAI、Ollama、one-api 等',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  {
    id: 'openai-responses',
    name: 'OpenAI Responses',
    hint: 'OpenAI 新版 /v1/responses 协议',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Messages',
    hint: 'Claude 系列 /v1/messages',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    hint: 'generativelanguage.googleapis.com',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.0-flash',
  },
  {
    id: 'custom',
    name: '自定义（任意 HTTP 接口）',
    hint: '自己填路径、鉴权方式、请求体模板和响应取值路径',
    baseUrl: '',
    model: '',
  },
];

export const AUTH_TYPES = [
  { id: 'bearer', name: 'Authorization: Bearer' },
  { id: 'x-api-key', name: 'x-api-key 请求头' },
  { id: 'header', name: '自定义请求头' },
  { id: 'query', name: 'URL 查询参数（?key=）' },
  { id: 'none', name: '不需要鉴权' },
];

const DEFAULT_CUSTOM_BODY = [
  '{',
  '  "model": "{{model}}",',
  '  "messages": {{messages}},',
  '  "temperature": {{temperature}},',
  '  "stream": {{stream}}',
  '}',
].join('\n');

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 把前端/磁盘上的连接对象补齐成固定结构 */
export function normalizeConnection(input = {}) {
  const protocol = PROTOCOLS.some((item) => item.id === input.protocol) ? input.protocol : 'openai-chat';
  const authType = AUTH_TYPES.some((item) => item.id === input.authType) ? input.authType : 'bearer';
  return {
    id: String(input.id || '').trim() || randomUUID(),
    name: String(input.name || '').trim() || '未命名连接',
    protocol,
    baseUrl: String(input.baseUrl || '').trim().replace(/\/+$/, ''),
    model: String(input.model || '').trim(),
    apiKey: String(input.apiKey || '').trim(),
    authType,
    authName: String(input.authName || '').trim(),
    headers: input.headers && typeof input.headers === 'object' ? { ...input.headers } : {},
    path: String(input.path || '').trim(),
    bodyTemplate: String(input.bodyTemplate || ''),
    responsePath: String(input.responsePath || '').trim(),
    deltaPath: String(input.deltaPath || '').trim(),
    temperature: num(input.temperature, 0.7),
    maxTokens: num(input.maxTokens, 0),
    topP: num(input.topP, 0),
    priceIn: num(input.priceIn, 0),
    priceOut: num(input.priceOut, 0),
  };
}

function protocolMeta(protocol) {
  return PROTOCOLS.find((item) => item.id === protocol) || PROTOCOLS[0];
}

function apiUrl(connection, path) {
  const base = (connection.baseUrl || protocolMeta(connection.protocol).baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('请填写接口地址（Base URL）');
  if (!path) return base;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** 支持 `choices[0].message.content` 这种简单取值路径 */
export function getPath(source, path) {
  if (!path) return '';
  const tokens = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let current = source;
  for (const token of tokens) {
    if (current === null || current === undefined) return '';
    current = current[token];
  }
  return current ?? '';
}

function authHeaders(connection, extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...connection.headers };
  const key = connection.apiKey;
  if (key) {
    if (connection.authType === 'x-api-key') headers['x-api-key'] = key;
    else if (connection.authType === 'header' && connection.authName) headers[connection.authName] = key;
    else if (connection.authType !== 'query' && connection.authType !== 'none') {
      headers.Authorization = `Bearer ${key}`;
    }
  }
  return { ...headers, ...extra };
}

function withQueryAuth(url, connection) {
  if (connection.authType !== 'query' || !connection.apiKey) return url;
  const name = connection.authName || 'key';
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${encodeURIComponent(name)}=${encodeURIComponent(connection.apiKey)}`;
}

function fillTemplate(template, values) {
  let out = String(template || DEFAULT_CUSTOM_BODY);
  for (const [key, value] of Object.entries(values)) {
    const json = JSON.stringify(value);
    out = out.split(`"{{${key}}}"`).join(json);
    out = out.split(`{{${key}}}`).join(json);
  }
  return JSON.parse(out);
}

function textFromParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => part?.text || part?.content || '').join('');
}

/** 非流式响应里取正文 */
function extractText(protocol, json) {
  switch (protocol) {
    case 'openai-chat':
      return json?.choices?.[0]?.message?.content || '';
    case 'openai-responses':
      if (json?.output_text) return json.output_text;
      return textFromParts((json?.output || []).flatMap((item) => item?.content || []));
    case 'anthropic':
      return textFromParts(json?.content || []);
    case 'gemini':
      return textFromParts(json?.candidates?.[0]?.content?.parts || []);
    default:
      return '';
  }
}

/** 流式增量取正文 */
function extractDelta(protocol, json) {
  switch (protocol) {
    case 'openai-chat':
      return json?.choices?.[0]?.delta?.content || '';
    case 'openai-responses':
      return json?.type === 'response.output_text.delta' ? json.delta || '' : '';
    case 'anthropic':
      return json?.type === 'content_block_delta' ? json?.delta?.text || '' : '';
    case 'gemini':
      return textFromParts(json?.candidates?.[0]?.content?.parts || []);
    default:
      return '';
  }
}

function extractUsage(protocol, json) {
  if (!json) return null;
  if (protocol === 'openai-chat' && json.usage) {
    return { input: num(json.usage.prompt_tokens, 0), output: num(json.usage.completion_tokens, 0) };
  }
  if (protocol === 'openai-responses') {
    const usage = json?.response?.usage || json?.usage;
    if (usage) return { input: num(usage.input_tokens, 0), output: num(usage.output_tokens, 0) };
  }
  if (protocol === 'anthropic') {
    const usage = json?.usage || json?.message?.usage;
    if (usage) return { input: num(usage.input_tokens, 0), output: num(usage.output_tokens, 0) };
  }
  if (protocol === 'gemini' && json.usageMetadata) {
    return {
      input: num(json.usageMetadata.promptTokenCount, 0),
      output: num(json.usageMetadata.candidatesTokenCount, 0),
    };
  }
  return null;
}

function buildRequest(connection, messages, options) {
  const { temperature, maxTokens, topP, stream } = options;
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const dialogue = messages.filter((message) => message.role !== 'system');
  const generation = { temperature, topP };

  if (connection.protocol === 'openai-chat') {
    const body = {
      model: connection.model,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      stream,
      temperature,
    };
    if (maxTokens > 0) body.max_tokens = maxTokens;
    if (topP > 0) body.top_p = topP;
    return {
      url: withQueryAuth(apiUrl(connection, '/chat/completions'), connection),
      headers: authHeaders(connection),
      body,
    };
  }

  if (connection.protocol === 'openai-responses') {
    const body = {
      model: connection.model,
      input: dialogue.map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: [{ type: 'input_text', text: message.content }],
      })),
      stream,
      temperature,
    };
    if (system) body.instructions = system;
    if (maxTokens > 0) body.max_output_tokens = maxTokens;
    if (topP > 0) body.top_p = topP;
    return {
      url: withQueryAuth(apiUrl(connection, '/responses'), connection),
      headers: authHeaders(connection),
      body,
    };
  }

  if (connection.protocol === 'anthropic') {
    const body = {
      model: connection.model,
      max_tokens: maxTokens > 0 ? maxTokens : 4096,
      messages: dialogue.map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      })),
      stream,
      temperature,
    };
    if (system) body.system = system;
    if (topP > 0) body.top_p = topP;
    return {
      url: withQueryAuth(apiUrl(connection, '/messages'), connection),
      headers: authHeaders(connection, { 'anthropic-version': '2023-06-01' }),
      body,
    };
  }

  if (connection.protocol === 'gemini') {
    const model = encodeURIComponent(connection.model || 'gemini-2.0-flash');
    const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const body = {
      contents: dialogue.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      })),
      generationConfig: {
        temperature,
        ...(maxTokens > 0 ? { maxOutputTokens: maxTokens } : {}),
        ...(topP > 0 ? { topP } : {}),
      },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    return {
      url: withQueryAuth(apiUrl(connection, `/models/${model}:${action}`), connection),
      headers: authHeaders(connection),
      body,
    };
  }

  // custom：完全按连接里的模板拼
  if (!connection.path) throw new Error('自定义连接需要填写请求路径，例如 /v1/chat/completions');
  const prompt = dialogue.map((message) => message.content).join('\n\n');
  const body = fillTemplate(connection.bodyTemplate || DEFAULT_CUSTOM_BODY, {
    model: connection.model,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    system,
    prompt,
    temperature,
    maxTokens,
    topP,
    stream,
  });
  return {
    url: withQueryAuth(apiUrl(connection, connection.path), connection),
    headers: authHeaders(connection),
    body,
  };
}

async function readSse(response, onData) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .filter(Boolean)
          .join('\n');
        if (data && data !== '[DONE]') {
          try {
            onData(JSON.parse(data));
          } catch {
            // 心跳/非 JSON 帧直接忽略
          }
        }
        index = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function describeError(response) {
  const raw = await response.text().catch(() => '');
  let detail = raw.slice(0, 400);
  try {
    const json = JSON.parse(raw);
    detail = json.error?.message || json.message || json.error || detail;
    if (typeof detail === 'object') detail = JSON.stringify(detail);
  } catch {
    // 保持原始文本
  }
  const prefix =
    response.status === 401 || response.status === 403
      ? '鉴权失败（检查 API Key 与鉴权方式）'
      : response.status === 404
        ? '接口不存在（检查 Base URL 与模型名）'
        : response.status === 429
          ? '请求过于频繁或额度不足'
          : `接口返回 ${response.status}`;
  return `${prefix}：${detail || response.statusText}`;
}

/**
 * 发起一次对话。onDelta 存在时自动走流式。
 * @returns {Promise<{text: string, usage: {input:number, output:number}|null}>}
 */
export async function chat({
  connection,
  messages,
  temperature,
  maxTokens,
  topP,
  stream = false,
  onDelta,
  signal,
}) {
  const conn = normalizeConnection(connection);
  if (!conn.model) throw new Error('请先填写模型名');
  const useStream = Boolean(stream || onDelta);
  const request = buildRequest(conn, messages, {
    temperature: num(temperature, conn.temperature),
    maxTokens: num(maxTokens, conn.maxTokens),
    topP: num(topP, conn.topP),
    stream: useStream,
  });

  let response;
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error(`无法连接接口（检查 Base URL 与网络）：${error.message}`);
  }
  if (!response.ok) throw new Error(await describeError(response));

  if (!useStream) {
    const json = await response.json();
    const text = conn.protocol === 'custom' ? getPath(json, conn.responsePath) : extractText(conn.protocol, json);
    return { text: String(text || ''), usage: extractUsage(conn.protocol, json) };
  }

  let text = '';
  let usage = null;
  await readSse(response, (json) => {
    const delta = conn.protocol === 'custom' ? getPath(json, conn.deltaPath) : extractDelta(conn.protocol, json);
    if (delta) {
      text += delta;
      onDelta?.(String(delta));
    }
    usage = extractUsage(conn.protocol, json) || usage;
  });
  return { text, usage };
}

/** 拉模型列表；接口不支持时抛错，由界面提示手填 */
export async function listModels(connection) {
  const conn = normalizeConnection(connection);
  let url = '';
  if (conn.protocol === 'gemini') url = withQueryAuth(apiUrl(conn, '/models'), conn);
  else if (conn.protocol === 'custom') url = withQueryAuth(apiUrl(conn, conn.path ? '/models' : ''), conn);
  else url = withQueryAuth(apiUrl(conn, '/models'), conn);

  const headers = authHeaders(conn, conn.protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {});
  delete headers['Content-Type'];
  let response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    throw new Error(`无法连接接口（检查 Base URL 与网络）：${error.message}`);
  }
  if (!response.ok) throw new Error(await describeError(response));
  const json = await response.json();
  const raw = json.data || json.models || [];
  const ids = raw
    .map((item) => (typeof item === 'string' ? item : item.id || item.name || ''))
    .map((id) => String(id).replace(/^models\//, ''))
    .filter(Boolean);
  return [...new Set(ids)].sort();
}

/** 连通性测试：发一句最短的请求，返回延迟和回显 */
export async function testConnection(connection) {
  const started = Date.now();
  const result = await chat({
    connection,
    messages: [{ role: 'user', content: '请只回复两个字：正常' }],
    maxTokens: 24,
    temperature: 0,
    signal: AbortSignal.timeout(30000),
  });
  return {
    ok: true,
    latency: Date.now() - started,
    reply: String(result.text || '').slice(0, 120),
    usage: result.usage,
  };
}
