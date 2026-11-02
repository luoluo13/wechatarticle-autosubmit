const $ = (selector) => document.querySelector(selector);

const DEFAULT_BODY_TEMPLATE = `{
  "model": "{{model}}",
  "messages": {{messages}},
  "temperature": {{temperature}},
  "stream": {{stream}}
}`;

const COMMANDS = [
  { value: '/style', hint: '参考往期稿件的文笔：/style 稿件名；off 关闭；空 列出可选' },
  { value: '/style off', hint: '关闭文笔参考' },
];

const app = {
  connections: [],
  templates: [],
  sessions: [],
  protocols: [],
  authTypes: [],
  platforms: [],
  articles: [],
  session: null,
  connectionId: localStorage.getItem('studio-conn') || '',
  templateId: localStorage.getItem('studio-tpl') || '',
  platform: localStorage.getItem('studio-plat') || '',
  styleSlug: '',
  editingConnection: '',
  editingTemplate: '',
  lastProtocol: '',
  streaming: false,
  abort: null,
  saveTimer: null,
  view: 'chat',
  commandMatches: [],
  commandIndex: 0,
};

/* ---------------------------------- 基础工具 -------------------------------- */

async function api(path, body) {
  const options = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('err', Boolean(isError));
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  if (date.toDateString() === now.toDateString()) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function protocolName(id) {
  return app.protocols.find((item) => item.id === id)?.name || id || '自定义';
}

function selectedConnection() {
  return app.connections.find((item) => item.id === app.connectionId) || null;
}

function selectedTemplate() {
  return app.templates.find((item) => item.id === app.templateId) || null;
}

/* ---------------------------------- 状态渲染 -------------------------------- */

function renderEnv() {
  const chips = [
    `${app.connections.length} 个连接`,
    `${app.templates.length} 个模板`,
    `${app.sessions.length} 个会话`,
  ];
  $('#studio-env').innerHTML = chips.map((text) => `<span class="chip">${text}</span>`).join('');
}

function renderSessions() {
  const list = $('#sessions');
  list.innerHTML = '';
  const items = [...app.sessions].sort((a, b) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt)),
  );

  for (const item of items) {
    const li = document.createElement('li');
    li.className = item.id === app.session?.id ? 'active' : '';
    li.title = item.title || '未命名会话';

    const title = document.createElement('span');
    title.className = 't';
    title.textContent = item.title || '未命名会话';

    const meta = document.createElement('span');
    meta.className = 's';
    meta.textContent = `${item.messages || 0} 条 · ${formatTime(item.updatedAt)}`;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.title = '删除会话';
    del.textContent = '×';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      removeSession(item).catch((error) => toast(error.message, true));
    });

    li.append(title, meta, del);
    li.addEventListener('click', () => {
      openSession(item.id).catch((error) => toast(error.message, true));
    });
    list.append(li);
  }

  renderEnv();
}

function renderConnections() {
  const list = $('#connections');
  list.innerHTML = '';

  for (const conn of app.connections) {
    const li = document.createElement('li');
    li.className = conn.id === app.connectionId ? 'active' : '';
    li.title = `${conn.name} · ${protocolName(conn.protocol)}`;

    const title = document.createElement('span');
    title.className = 't';
    title.textContent = conn.name;

    const meta = document.createElement('span');
    meta.className = 's';
    const bits = [conn.model || '未填模型'];
    if (!conn.hasKey) bits.push('无 Key');
    meta.textContent = bits.join(' · ');

    li.append(title, meta);
    li.addEventListener('click', () => selectConnection(conn.id));
    li.addEventListener('dblclick', () => openConnectionDialog(conn.id));
    list.append(li);
  }

  if (!app.connections.length) {
    const tip = document.createElement('li');
    tip.style.cursor = 'default';
    const span = document.createElement('span');
    span.className = 's';
    span.textContent = '还没有连接，点上方「添加」';
    tip.append(span);
    list.append(tip);
  }
}

function renderSide() {
  const connectionSelect = $('#connection-select');
  connectionSelect.innerHTML = '';
  if (!app.connections.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '未配置连接';
    connectionSelect.append(option);
  }
  for (const conn of app.connections) {
    const option = document.createElement('option');
    option.value = conn.id;
    option.textContent = `${conn.name} · ${conn.model || '未填模型'}`;
    connectionSelect.append(option);
  }
  connectionSelect.value = app.connections.some((conn) => conn.id === app.connectionId)
    ? app.connectionId
    : '';

  const templateSelect = $('#template-select');
  templateSelect.innerHTML = '';
  for (const template of app.templates) {
    const option = document.createElement('option');
    option.value = template.id;
    option.textContent = `${template.name}${template.builtin ? ' · 内置' : ''}`;
    templateSelect.append(option);
  }
  templateSelect.value = app.templates.some((item) => item.id === app.templateId)
    ? app.templateId
    : '';

  const platformSelect = $('#platform-select');
  platformSelect.innerHTML = '';
  for (const platform of app.platforms) {
    const option = document.createElement('option');
    option.value = platform.id;
    option.textContent = platform.name;
    platformSelect.append(option);
  }
  platformSelect.value = app.platform;

  const styleSelect = $('#style-select');
  styleSelect.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '不参考往期文笔';
  styleSelect.append(none);
  for (const article of app.articles) {
    const option = document.createElement('option');
    option.value = article.slug;
    option.textContent = article.title || article.slug;
    styleSelect.append(option);
  }
  styleSelect.value = app.articles.some((item) => item.slug === app.styleSlug)
    ? app.styleSlug
    : '';

  const template = selectedTemplate();
  $('#delete-template').disabled = !template || Boolean(template.builtin);
}

function renderMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  const messages = app.session?.messages || [];

  if (!messages.length) {
    const empty = document.createElement('p');
    empty.className = 'chat-empty';
    empty.textContent = '先聊选题和大纲，聊顺了就点「整理成文章」。';
    box.append(empty);
    return;
  }

  for (const message of messages) {
    const label =
      message.role === 'user' ? '我' : message.mode === 'compose' ? '成稿' : '模型';
    box.append(messageEl(message.role, message.content, label));
  }
  box.scrollTop = box.scrollHeight;
}

function renderDraftInfo() {
  const text = $('#draft-text').value;
  const hasDraft = Boolean(text.trim());
  for (const id of ['#copy-draft', '#improve-draft', '#import-draft']) {
    $(id).disabled = !hasDraft;
  }
  if (!hasDraft) {
    $('#draft-info').textContent = '还没有成稿';
    return;
  }
  const chars = text.replace(/\s+/g, '').length;
  const usage = app.session?.usage || { input: 0, output: 0 };
  $('#draft-info').textContent = `${chars} 字 · 累计 ${(usage.input || 0) + (usage.output || 0)} token`;
}

function setView(view) {
  app.view = view === 'draft' ? 'draft' : 'chat';
  document
    .querySelectorAll('.chat-tabs .tab')
    .forEach((tab) => tab.classList.toggle('active', tab.dataset.view === app.view));
  $('#chat-pane').hidden = app.view !== 'chat';
  $('#draft-pane').hidden = app.view !== 'draft';
  if (app.view === 'draft') renderDraftInfo();
}

function updateControls() {
  $('#send-btn').disabled = app.streaming;
  $('#compose-btn').disabled = app.streaming;
  $('#stop-btn').hidden = !app.streaming;
}

/* ---------------------------------- 会话加载 -------------------------------- */

function summaryOf(session) {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    connectionId: session.connectionId || '',
    templateId: session.templateId || '',
    platform: session.platform || '',
    messages: session.messages?.length || 0,
    articleSlug: session.articleSlug || '',
  };
}

function applySession(session) {
  app.session = session;
  app.connectionId = session.connectionId || app.connectionId;
  app.templateId = session.templateId || app.templateId;
  app.platform = session.platform || app.platform;

  localStorage.setItem('studio-conn', app.connectionId);
  localStorage.setItem('studio-tpl', app.templateId);
  localStorage.setItem('studio-plat', app.platform);

  const params = session.params || {};
  $('#audience').value = params.audience || '';
  $('#tone').value = params.tone || '';
  $('#length').value = params.length || '';
  $('#keywords').value = params.keywords || '';
  app.styleSlug = params.styleSlug || '';

  const conn = selectedConnection();
  $('#temperature').value = firstDefined(params.temperature, conn?.temperature, 0.7);
  $('#max-tokens').value = firstDefined(params.maxTokens, conn?.maxTokens, 0);

  $('#draft-text').value = session.draft || '';
  renderMessages();
  renderDraftInfo();
  renderSessions();
  renderSide();
}

async function loadState() {
  const state = await api('/api/studio/state');
  app.connections = state.connections || [];
  app.templates = state.templates || [];
  app.sessions = state.sessions || [];
  app.protocols = state.protocols || [];
  app.authTypes = state.authTypes || [];
  app.platforms = state.platforms || [];
  app.articles = state.articles || [];

  if (!app.connections.some((conn) => conn.id === app.connectionId)) {
    app.connectionId =
      (app.connections.find((conn) => conn.hasKey) || app.connections[0] || {}).id || '';
    localStorage.setItem('studio-conn', app.connectionId);
  }
  if (!app.templates.some((template) => template.id === app.templateId)) {
    app.templateId = app.templates[0]?.id || '';
    localStorage.setItem('studio-tpl', app.templateId);
  }
  if (!app.platforms.some((platform) => platform.id === app.platform)) {
    app.platform =
      (app.platforms.find((platform) => platform.id === 'wechat') || app.platforms[0] || {}).id ||
      '';
    localStorage.setItem('studio-plat', app.platform);
  }

  renderConnections();
  renderSessions();
  renderSide();
}

async function openSession(id) {
  if (app.streaming) return toast('正在生成，先停止', true);
  await savePatchNow();
  const session = await api(`/api/studio/session?id=${encodeURIComponent(id)}`);
  $('#chat-state').textContent = '';
  applySession(session);
  setView('chat');
}

async function reloadSession() {
  if (!app.session) return;
  const session = await api(`/api/studio/session?id=${encodeURIComponent(app.session.id)}`);
  applySession(session);
}

async function newSession() {
  if (app.streaming) return toast('正在生成，先停止', true);
  await savePatchNow();
  const session = await api('/api/studio/session', {
    connectionId: app.connectionId,
    templateId: app.templateId,
    platform: app.platform,
    params: currentParams(),
  });
  app.sessions.push(summaryOf(session));
  $('#chat-state').textContent = '';
  applySession(session);
  setView('chat');
  $('#composer-input').focus();
  toast('已新建会话');
}

async function ensureSession() {
  if (app.session) return app.session;
  const session = await api('/api/studio/session', {
    connectionId: app.connectionId,
    templateId: app.templateId,
    platform: app.platform,
    params: currentParams(),
  });
  app.sessions.push(summaryOf(session));
  applySession(session);
  return session;
}

async function removeSession(item) {
  if (app.streaming && app.session?.id === item.id) {
    return toast('正在生成，先停止', true);
  }
  if (!window.confirm(`删除会话「${item.title || '未命名会话'}」？`)) return;
  await api('/api/studio/session/remove', { id: item.id });
  app.sessions = app.sessions.filter((session) => session.id !== item.id);

  if (app.session?.id === item.id) {
    app.session = null;
    $('#draft-text').value = '';
    $('#chat-state').textContent = '';
    renderMessages();
    renderDraftInfo();
  }
  renderSessions();
  toast('会话已删除');
}

/* ---------------------------------- 参数保存 -------------------------------- */

function currentParams() {
  return {
    platform: app.platform,
    tone: $('#tone').value.trim(),
    length: $('#length').value.trim(),
    audience: $('#audience').value.trim(),
    keywords: $('#keywords').value.trim(),
    styleSlug: app.styleSlug,
    temperature: numberOr($('#temperature').value, 0.7),
    maxTokens: numberOr($('#max-tokens').value, 0),
  };
}

function scheduleSave() {
  if (!app.session) return;
  clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(() => {
    savePatchNow().catch(() => {});
  }, 700);
}

async function savePatchNow() {
  if (!app.session) return;
  const result = await api('/api/studio/session/draft', {
    id: app.session.id,
    draft: $('#draft-text').value,
    connectionId: app.connectionId,
    templateId: app.templateId,
    platform: app.platform,
    params: currentParams(),
  });
  app.session.draft = result.draft ?? app.session.draft;
  app.session.updatedAt = result.updatedAt || app.session.updatedAt;

  const summary = app.sessions.find((item) => item.id === app.session.id);
  if (summary) {
    summary.updatedAt = app.session.updatedAt;
    summary.connectionId = app.connectionId;
    summary.templateId = app.templateId;
    summary.platform = app.platform;
    summary.messages = app.session.messages?.length || summary.messages;
  }
}

/* ---------------------------------- 选择联动 -------------------------------- */

function selectConnection(id) {
  if (app.streaming) return toast('正在生成，先停止', true);
  app.connectionId = id;
  localStorage.setItem('studio-conn', id);
  if (app.session) app.session.connectionId = id;

  const conn = selectedConnection();
  $('#temperature').value = conn?.temperature ?? 0.7;
  $('#max-tokens').value = conn?.maxTokens ?? 0;
  $('#connection-select').value = id;
  renderConnections();
  scheduleSave();
}

function selectTemplate(id) {
  app.templateId = id;
  localStorage.setItem('studio-tpl', id);
  if (app.session) app.session.templateId = id;
  $('#template-select').value = id;
  const template = selectedTemplate();
  $('#delete-template').disabled = !template || Boolean(template.builtin);
  scheduleSave();
}

function selectPlatform(id) {
  app.platform = id;
  localStorage.setItem('studio-plat', id);
  if (app.session) app.session.platform = id;
  $('#platform-select').value = id;
  scheduleSave();
}

function selectStyle(slug) {
  app.styleSlug = slug || '';
  if (app.session) {
    app.session.params = { ...(app.session.params || {}), styleSlug: app.styleSlug };
  }
  $('#style-select').value = app.styleSlug;
  scheduleSave();
}

function matchArticle(keyword) {
  const value = String(keyword || '').trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return app.articles[Number(value) - 1] || null;
  const lower = value.toLowerCase();
  return (
    app.articles.find((item) => item.slug.toLowerCase() === lower) ||
    app.articles.find((item) => String(item.title || '').toLowerCase() === lower) ||
    app.articles.find((item) => String(item.title || '').toLowerCase().includes(lower)) ||
    app.articles.find((item) => item.slug.toLowerCase().includes(lower)) ||
    null
  );
}

/** 解析 /style 命令；不是命令返回 null，命令执行失败返回 ok:false */
function handleStyleCommand(text) {
  if (!/^\/style(\s|$)/i.test(text)) return null;
  const [first, ...rest] = text.split(/\r?\n/);
  const arg = first.replace(/^\/style\s*/i, '').trim();
  const remainder = rest.join('\n').trim();

  if (!arg || arg.toLowerCase() === 'list') {
    setView('chat');
    if (!app.articles.length) {
      appendCommand('还没有可参考的稿件：先去发布台新建一篇，再回来试试。', true);
    } else {
      const lines = app.articles.map(
        (item, index) => `${index + 1}. ${item.title || item.slug}`,
      );
      appendCommand(
        `可用文笔：\n${lines.join('\n')}\n\n发「/style 稿件名」或「/style 序号」切换，/style off 关闭。`,
      );
    }
    return { ok: true, remainder };
  }

  if (['off', 'none', '关闭'].includes(arg.toLowerCase())) {
    selectStyle('');
    setView('chat');
    appendCommand('已关闭文笔参考。');
    return { ok: true, remainder };
  }

  const article = matchArticle(arg);
  if (!article) {
    setView('chat');
    appendCommand(`没找到稿件「${arg}」，发 /style 查看可用列表。`, true);
    return { ok: false, remainder: '' };
  }
  selectStyle(article.slug);
  setView('chat');
  appendCommand(`文笔参考已切换：《${article.title || article.slug}》`);
  return { ok: true, remainder };
}

/* ---------------------------------- 消息渲染 -------------------------------- */

function messageEl(role, text, label) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = label || (role === 'user' ? '我' : '模型');

  const body = document.createElement('span');
  body.className = 'body';
  body.textContent = text || '';

  wrap.append(who, body);
  return wrap;
}

function scrollMessages() {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
}

function appendError(text) {
  const el = messageEl('assistant', text, '错误');
  el.classList.add('error');
  $('#messages').append(el);
  scrollMessages();
}

/** 命令结果直接写进聊天区，不用 toast 弹窗 */
function appendCommand(text, isError = false) {
  const box = $('#messages');
  box.querySelector('.chat-empty')?.remove();
  const el = messageEl('assistant', text, isError ? '错误' : '命令');
  el.classList.add('command');
  if (isError) el.classList.add('error');
  box.append(el);
  scrollMessages();
}

/* ---------------------------------- 命令补全 -------------------------------- */

/** 光标所在行以 / 开头且还没输入空格时，返回小写命令前缀 */
function commandQuery() {
  const input = $('#composer-input');
  const caret = input.selectionStart ?? input.value.length;
  const line = input.value.slice(0, caret).split(/\r?\n/).pop();
  if (!line.startsWith('/') || /\s/.test(line)) return '';
  return line.toLowerCase();
}

function hideCommandMenu() {
  $('#command-menu').hidden = true;
  app.commandMatches = [];
  app.commandIndex = 0;
}

function renderCommandMenu() {
  const query = commandQuery();
  if (!query) return hideCommandMenu();

  const matches = COMMANDS.filter((item) => item.value.startsWith(query));
  if (!matches.length) return hideCommandMenu();

  app.commandMatches = matches;
  if (app.commandIndex >= matches.length) app.commandIndex = 0;

  const list = $('#command-list');
  list.innerHTML = '';
  matches.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = index === app.commandIndex ? 'active' : '';

    const value = document.createElement('span');
    value.className = 'v';
    value.textContent = item.value;

    const desc = document.createElement('span');
    desc.className = 'd';
    desc.textContent = item.hint;

    li.append(value, desc);
    // mousedown 代替 click，避免输入框先失焦
    li.addEventListener('mousedown', (event) => {
      event.preventDefault();
      applyCommand(index);
    });
    list.append(li);
  });

  $('#command-menu').hidden = false;
}

/** 用选中的命令替换光标所在行的命令前缀，并补一个空格 */
function applyCommand(index) {
  const item = app.commandMatches[index];
  if (!item) return;
  const input = $('#composer-input');
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const after = input.value.slice(caret);
  const lineStart = before.lastIndexOf('\n') + 1;
  const head = before.slice(0, lineStart);

  input.value = `${head}${item.value} ${after}`;
  const pos = lineStart + item.value.length + 1;
  input.setSelectionRange(pos, pos);
  hideCommandMenu();
  input.focus();
}

/* ---------------------------------- 流式请求 -------------------------------- */

function canGenerate() {
  if (!app.connections.length) {
    toast('先添加一个模型连接', true);
    openConnectionDialog();
    return false;
  }
  const conn = selectedConnection();
  if (!conn) {
    toast('先选择一个模型连接', true);
    return false;
  }
  if (!conn.model) {
    toast('这个连接还没有填模型名', true);
    openConnectionDialog(conn.id);
    return false;
  }
  return true;
}

async function streamChat(payload, handlers) {
  const controller = new AbortController();
  app.abort = controller;

  const res = await fetch('/api/studio/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  if (!res.body) throw new Error('当前浏览器不支持流式响应');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);

      let event = 'message';
      let data = '';
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }

      if (data) {
        try {
          const parsed = JSON.parse(data);
          handlers[event]?.(parsed);
        } catch {
          // 忽略非 JSON 帧
        }
      }
      index = buffer.indexOf('\n\n');
    }
  }

  if (app.abort === controller) app.abort = null;
}

function stopStream() {
  if (!app.abort) return;
  app.abort.abort();
  app.abort = null;
}

async function startStream(mode, message = '') {
  if (app.streaming) return;
  if (!canGenerate()) return;

  let session;
  try {
    session = await ensureSession();
  } catch (error) {
    return toast(error.message, true);
  }

  await savePatchNow().catch(() => {});

  const isCompose = mode === 'compose';
  const topic = String(message || '').trim();

  app.streaming = true;
  updateControls();
  $('#chat-state').textContent = isCompose ? '整理中…' : '生成中…';

  let bubble = null;
  if (!isCompose) {
    $('#messages').querySelector('.chat-empty')?.remove();
    $('#messages').append(messageEl('user', topic, '我'));
    bubble = messageEl('assistant', '', '模型');
    bubble.classList.add('streaming');
    $('#messages').append(bubble);
    scrollMessages();
  } else {
    $('#draft-text').value = '';
    setView('draft');
    $('#draft-info').textContent = '成稿正在生成中，请耐心等待…';
  }

  let text = '';
  let failure = '';
  let aborted = false;
  let completed = false;

  try {
    await streamChat(
      {
        sessionId: session.id,
        connectionId: app.connectionId,
        templateId: app.templateId,
        mode,
        message: topic,
        draft: isCompose ? $('#draft-text').value : '',
        temperature: numberOr($('#temperature').value, 0.7),
        maxTokens: numberOr($('#max-tokens').value, 0),
        params: currentParams(),
      },
      {
        meta: (data) => {
          $('#chat-state').textContent = [data.connection, data.model].filter(Boolean).join(' · ');
        },
        delta: (data) => {
          const delta = data.text || '';
          text += delta;
          if (isCompose) {
            const area = $('#draft-text');
            area.value += delta;
            area.scrollTop = area.scrollHeight;
            renderDraftInfo();
          } else if (bubble) {
            bubble.querySelector('.body').textContent += delta;
            scrollMessages();
          }
        },
        done: (data) => {
          completed = true;
          text = data.text || text;
          if (data.totalUsage) app.session.usage = data.totalUsage;
          if (data.session?.title) app.session.title = data.session.title;

          if (isCompose) {
            $('#draft-text').value = text;
            renderDraftInfo();
            setView('draft');
          } else if (bubble) {
            bubble.classList.remove('streaming');
            bubble.querySelector('.body').textContent = text;
          }

          $('#chat-state').textContent = data.cost
            ? `完成 · 约 ${Number(data.cost).toFixed(4)}`
            : '完成';
        },
        error: (data) => {
          failure = data.message || '生成失败';
          if (data.partial) text = data.partial;
        },
      },
    );
  } catch (error) {
    if (error.name === 'AbortError') aborted = true;
    else failure = error.message;
  }

  app.streaming = false;
  app.abort = null;
  updateControls();
  if (bubble) bubble.classList.remove('streaming');

  if (aborted) {
    toast('已停止生成');
  } else if (failure) {
    failure = failure === '已停止生成' ? '已停止生成' : failure;
    $('#chat-state').textContent = failure;
    toast(failure, true);
    if (!isCompose) appendError(failure);
    else renderDraftInfo();
  } else if (!completed) {
    toast('连接中断，已保留生成的部分', true);
  } else if (isCompose) {
    toast('成稿已生成，可以继续修改或导入发布台');
  }

  if (aborted) {
    setTimeout(() => {
      reloadSession().catch(() => {});
    }, 800);
  } else {
    await reloadSession().catch(() => {});
  }
}

async function sendMessage() {
  if (app.streaming) return;
  const input = $('#composer-input');
  let message = input.value.trim();
  if (!message) return toast('先写点什么再发送', true);

  const command = handleStyleCommand(message);
  if (command) {
    if (!command.ok) return;
    message = command.remainder;
    hideCommandMenu();
    if (!message) {
      input.value = '';
      return;
    }
  }

  if (!canGenerate()) return;
  hideCommandMenu();
  input.value = '';
  await startStream('chat', message);
}

async function composeArticle() {
  if (app.streaming) return;
  let topic = $('#composer-input').value.trim();
  const command = topic ? handleStyleCommand(topic) : null;
  if (command) {
    if (!command.ok) return;
    topic = command.remainder;
  }
  hideCommandMenu();
  $('#composer-input').value = '';
  await startStream('compose', topic);
}

/* ---------------------------------- 成稿操作 -------------------------------- */

function draftTitle() {
  const match = $('#draft-text').value.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function slugify(title) {
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
  return `studio-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

async function copyDraft() {
  const text = $('#draft-text').value;
  if (!text.trim()) return toast('还没有成稿', true);
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制 Markdown');
  } catch {
    const area = $('#draft-text');
    area.select();
    document.execCommand('copy');
    toast('已复制');
  }
}

function improveDraft() {
  setView('chat');
  $('#composer-input').value = '';
  $('#composer-input').placeholder = '说说这一版要改哪里，比如「第二节太啰嗦，压到三行」';
  $('#composer-input').focus();
  toast('描述修改方向，再点「整理成文章」');
}

/* ---------------------------------- 模型连接 -------------------------------- */

function applyProtocolMeta(protocolId) {
  const meta = app.protocols.find((item) => item.id === protocolId) || {};
  $('#c-protocol-hint').textContent = meta.hint || '';
  $('#c-custom-block').hidden = protocolId !== 'custom';
  if (protocolId === 'custom') $('#c-custom-block').open = true;
}

function openConnectionDialog(id = '') {
  if (!app.protocols.length) return;
  const conn = app.connections.find((item) => item.id === id) || null;
  app.editingConnection = conn?.id || '';

  $('#c-protocol').innerHTML = app.protocols
    .map((item) => `<option value="${item.id}">${item.name}</option>`)
    .join('');
  $('#c-auth-type').innerHTML = app.authTypes
    .map((item) => `<option value="${item.id}">${item.name}</option>`)
    .join('');

  const protocol = conn?.protocol || app.protocols[0].id;
  app.lastProtocol = protocol;

  $('#connection-title').textContent = conn ? '编辑连接' : '新建连接';
  $('#c-name').value = conn?.name || '';
  $('#c-protocol').value = protocol;
  $('#c-base').value = conn?.baseUrl || '';
  $('#c-model').value = conn?.model || '';
  $('#c-key').value = '';
  $('#c-key').placeholder = conn?.hasKey ? `已保存 ${conn.keyHint}，留空沿用` : '粘贴 API Key';
  $('#c-key-hint').textContent = conn?.hasKey
    ? `已保存 Key：${conn.keyHint}，留空表示不修改。`
    : 'Key 只保存在本机 data/studio/connections.json。';
  $('#c-auth-type').value = conn?.authType || 'bearer';
  $('#c-auth-name').value = conn?.authName || '';
  $('#c-path').value = conn?.path || '';
  $('#c-body').value = conn?.bodyTemplate || (protocol === 'custom' ? DEFAULT_BODY_TEMPLATE : '');
  $('#c-response-path').value = conn?.responsePath || '';
  $('#c-delta-path').value = conn?.deltaPath || '';
  $('#c-temperature').value = conn?.temperature ?? 0.7;
  $('#c-max-tokens').value = conn?.maxTokens ?? 0;
  $('#c-price-in').value = conn?.priceIn ?? 0;
  $('#c-price-out').value = conn?.priceOut ?? 0;
  $('#c-remove').hidden = !conn;
  $('#c-result').textContent = '';
  $('#c-models').innerHTML = '';

  if (!conn) {
    const meta = app.protocols.find((item) => item.id === protocol);
    $('#c-base').value = meta?.baseUrl || '';
    $('#c-model').value = meta?.model || '';
  }

  applyProtocolMeta(protocol);
  $('#connection-dialog').showModal();
}

function onProtocolChange() {
  const nextId = $('#c-protocol').value;
  const previous = app.protocols.find((item) => item.id === app.lastProtocol);
  const next = app.protocols.find((item) => item.id === nextId) || {};
  const base = $('#c-base');
  const model = $('#c-model');

  if (!base.value || base.value === previous?.baseUrl) base.value = next.baseUrl || '';
  if (!model.value || model.value === previous?.model) model.value = next.model || '';
  if (nextId === 'custom' && !$('#c-body').value.trim()) {
    $('#c-body').value = DEFAULT_BODY_TEMPLATE;
  }

  app.lastProtocol = nextId;
  $('#c-models').innerHTML = '';
  applyProtocolMeta(nextId);
}

function readConnectionForm() {
  const model = $('#c-model').value.trim();
  return {
    id: app.editingConnection,
    name: $('#c-name').value.trim() || model || '未命名连接',
    protocol: $('#c-protocol').value,
    baseUrl: $('#c-base').value.trim(),
    model,
    apiKey: $('#c-key').value,
    authType: $('#c-auth-type').value,
    authName: $('#c-auth-name').value.trim(),
    path: $('#c-path').value.trim(),
    bodyTemplate: $('#c-body').value,
    responsePath: $('#c-response-path').value.trim(),
    deltaPath: $('#c-delta-path').value.trim(),
    temperature: numberOr($('#c-temperature').value, 0.7),
    maxTokens: numberOr($('#c-max-tokens').value, 0),
    priceIn: numberOr($('#c-price-in').value, 0),
    priceOut: numberOr($('#c-price-out').value, 0),
  };
}

async function saveConnectionForm() {
  const button = $('#c-save');
  button.disabled = true;
  try {
    const saved = await api('/api/studio/connection', readConnectionForm());
    await loadState();
    selectConnection(saved.id);
    $('#connection-dialog').close();
    toast('连接已保存');
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function testConnectionForm() {
  const output = $('#c-result');
  const button = $('#c-test');
  output.textContent = '测试中…';
  button.disabled = true;
  try {
    const data = await api('/api/studio/connection/test', {
      id: app.editingConnection,
      connection: readConnectionForm(),
    });
    output.textContent = `通过 · ${data.latency} ms\n模型回复：${data.reply || '(空)'}`;
  } catch (error) {
    output.textContent = `失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function testSelectedConnection() {
  const conn = selectedConnection();
  if (!conn) return toast('先选择一个连接', true);
  toast('测试中…');
  try {
    const data = await api('/api/studio/connection/test', { id: conn.id, connection: {} });
    toast(`通过 · ${data.latency} ms · ${data.reply || '(空)'}`);
  } catch (error) {
    toast(error.message, true);
  }
}

async function removeConnectionForm() {
  if (!app.editingConnection) return;
  if (!window.confirm('删除这个连接？保存的 Key 也会一起删掉。')) return;
  try {
    await api('/api/studio/connection/remove', { id: app.editingConnection });
    $('#connection-dialog').close();
    await loadState();
    scheduleSave();
    toast('连接已删除');
  } catch (error) {
    toast(error.message, true);
  }
}

async function pullModels() {
  const conn = selectedConnection();
  if (!conn) return toast('先选择一个连接', true);
  toast('正在拉取模型列表…');
  try {
    const data = await api(`/api/studio/models?id=${encodeURIComponent(conn.id)}`);
    openConnectionDialog(conn.id);
    const list = $('#c-models');
    list.innerHTML = '';
    for (const model of data.models || []) {
      const option = document.createElement('option');
      option.value = model;
      list.append(option);
    }
    toast(
      data.models?.length ? `拿到 ${data.models.length} 个模型，可在输入框里选` : '接口没有返回模型列表',
      !data.models?.length,
    );
  } catch (error) {
    toast(error.message, true);
  }
}

/* ---------------------------------- 提示词模板 ------------------------------- */

function openTemplateDialog(id) {
  const template = app.templates.find((item) => item.id === id) || app.templates[0];
  if (!template) return;
  app.editingTemplate = template.id;

  $('#template-title').textContent = template.builtin
    ? `${template.name}（内置，保存会另存为自定义模板）`
    : template.name;
  $('#t-name').value = template.name;
  $('#t-desc').value = template.desc || '';
  $('#t-system').value = template.system || '';
  $('#t-user').value = template.user || '';
  $('#template-dialog').showModal();
}

async function saveTemplateForm() {
  const button = $('#t-save');
  button.disabled = true;
  try {
    const saved = await api('/api/studio/template', {
      id: app.editingTemplate,
      name: $('#t-name').value.trim() || '未命名模板',
      desc: $('#t-desc').value.trim(),
      system: $('#t-system').value,
      user: $('#t-user').value,
    });
    $('#template-dialog').close();
    await loadState();
    selectTemplate(saved.id);
    toast('模板已保存');
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function removeTemplate(id) {
  const template = app.templates.find((item) => item.id === id);
  if (!template) return;
  if (template.builtin) return toast('内置模板不能删除，可以复制一份再改', true);
  if (!window.confirm(`删除模板「${template.name}」？`)) return;
  try {
    await api('/api/studio/template/remove', { id });
    await loadState();
    scheduleSave();
    toast('模板已删除');
  } catch (error) {
    toast(error.message, true);
  }
}

/* ---------------------------------- 导入发布台 ------------------------------ */

function openImportDialog() {
  const markdown = $('#draft-text').value.trim();
  if (!markdown) return toast('还没有成稿', true);
  if (!app.session) return toast('会话还没有保存', true);

  const title =
    draftTitle() ||
    (app.session.title && app.session.title !== '未命名会话' ? app.session.title : '未命名文章');
  $('#i-title').value = title;
  $('#i-slug').value = slugify(title);
  $('#i-tags').value = $('#keywords').value.trim();
  $('#i-digest').value = '';
  $('#import-dialog').showModal();
}

async function confirmImport() {
  const markdown = $('#draft-text').value.trim();
  if (!markdown) return toast('成稿是空的', true);
  if (!app.session) return toast('会话还没有保存', true);

  const title = $('#i-title').value.trim() || '未命名文章';
  const slug = $('#i-slug').value.trim() || slugify(title);
  const digest = $('#i-digest').value.trim();
  const tags = $('#i-tags')
    .value.split(/[,，、\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);

  const button = $('#i-confirm');
  button.disabled = true;
  try {
    await savePatchNow();
    const result = await api('/api/studio/import', {
      sessionId: app.session.id,
      markdown,
      title,
      slug,
      fields: {
        ...(digest ? { digest } : {}),
        ...(tags.length ? { tags } : {}),
      },
    });
    location.href = `/?slug=${encodeURIComponent(result.slug)}`;
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
  }
}

/* ---------------------------------- 绑定事件 -------------------------------- */

function bind() {
  $('#new-session').addEventListener('click', () => {
    newSession().catch((error) => toast(error.message, true));
  });
  $('#new-connection').addEventListener('click', () => openConnectionDialog());
  $('#edit-connection').addEventListener('click', () => openConnectionDialog(app.connectionId));
  $('#test-connection').addEventListener('click', () => testSelectedConnection());
  $('#pull-models').addEventListener('click', () => pullModels());
  $('#edit-template').addEventListener('click', () => openTemplateDialog(app.templateId));
  $('#delete-template').addEventListener('click', () => removeTemplate(app.templateId));

  $('#connection-select').addEventListener('change', (event) => selectConnection(event.target.value));
  $('#template-select').addEventListener('change', (event) => selectTemplate(event.target.value));
  $('#platform-select').addEventListener('change', (event) => selectPlatform(event.target.value));
  $('#style-select').addEventListener('change', (event) => selectStyle(event.target.value));

  for (const id of ['#audience', '#tone', '#length', '#keywords', '#temperature', '#max-tokens']) {
    $(id).addEventListener('input', scheduleSave);
  }

  $('#draft-text').addEventListener('input', () => {
    renderDraftInfo();
    scheduleSave();
  });

  $('#send-btn').addEventListener('click', () => {
    sendMessage().catch((error) => toast(error.message, true));
  });
  $('#compose-btn').addEventListener('click', () => {
    composeArticle().catch((error) => toast(error.message, true));
  });
  $('#stop-btn').addEventListener('click', stopStream);
  $('#composer-input').addEventListener('keydown', (event) => {
    const menuOpen = !$('#command-menu').hidden;
    if (menuOpen && !event.isComposing && event.keyCode !== 229) {
      if (event.key === 'Tab') {
        event.preventDefault();
        applyCommand(app.commandIndex);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        hideCommandMenu();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const total = app.commandMatches.length;
        app.commandIndex = (app.commandIndex + step + total) % total;
        renderCommandMenu();
        return;
      }
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    // 中文输入法选词时的回车不发送
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    sendMessage().catch((error) => toast(error.message, true));
  });
  $('#composer-input').addEventListener('input', () => {
    app.commandIndex = 0;
    renderCommandMenu();
  });
  $('#composer-input').addEventListener('blur', hideCommandMenu);

  document.querySelectorAll('.chat-tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => setView(tab.dataset.view));
  });

  $('#copy-draft').addEventListener('click', () => {
    copyDraft().catch((error) => toast(error.message, true));
  });
  $('#improve-draft').addEventListener('click', improveDraft);
  $('#import-draft').addEventListener('click', openImportDialog);

  $('#c-protocol').addEventListener('change', onProtocolChange);
  $('#c-save').addEventListener('click', () => saveConnectionForm());
  $('#c-test').addEventListener('click', () => testConnectionForm());
  $('#c-remove').addEventListener('click', () => removeConnectionForm());
  $('#t-save').addEventListener('click', () => saveTemplateForm());
  $('#i-confirm').addEventListener('click', () => confirmImport());

  document.querySelectorAll('dialog form').forEach((form) => {
    form.addEventListener('submit', (event) => event.preventDefault());
  });
  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => button.closest('dialog').close());
  });

  window.addEventListener('beforeunload', (event) => {
    if (app.streaming) event.preventDefault();
  });
}

async function boot() {
  bind();
  try {
    await loadState();
    if (app.sessions[0]) await openSession(app.sessions[0].id);
    if (!app.session) {
      const conn = selectedConnection();
      $('#temperature').value = conn?.temperature ?? 0.7;
      $('#max-tokens').value = conn?.maxTokens ?? 0;
      renderDraftInfo();
    }
    updateControls();
    if (!app.connections.length) openConnectionDialog();
  } catch (error) {
    toast(`无法连接本地服务：${error.message}`, true);
  }
}

boot();
