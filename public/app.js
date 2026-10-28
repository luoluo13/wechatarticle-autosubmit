const $ = (selector) => document.querySelector(selector);

const app = {
  articles: [],
  themes: [],
  env: {},
  slug: null,
  dirty: false,
  busy: false,
  saveTimer: null,
  jobId: null,
  jobAction: null,
  logCount: 0,
  logLines: [],
  setupPrompted: false,
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
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------------------------------- 状态渲染 -------------------------------- */

function envChips() {
  const { env } = app;
  const chips = [
    { text: `node ${env.node || '?'}`, state: '' },
    { text: env.deps ? '依赖已装' : '依赖缺失', state: env.deps ? '' : 'off' },
    { text: env.browsers ? '浏览器已装' : '浏览器缺失', state: env.browsers ? '' : 'off' },
    { text: env.auth ? '登录凭证存在' : '未登录', state: env.auth ? '' : 'warn' },
  ];
  $('#env').innerHTML = chips
    .map((chip) => `<span class="chip ${chip.state}">${chip.text}</span>`)
    .join('');
}

function renderList() {
  const list = $('#articles');
  list.innerHTML = '';
  for (const article of app.articles) {
    const li = document.createElement('li');
    li.className = `${article.slug === app.slug ? 'active' : ''} ${article.built ? 'built' : ''}`;
    li.innerHTML = `<span class="t"></span><span class="s"></span>`;
    li.querySelector('.t').textContent = article.title || article.slug;
    li.querySelector('.s').textContent = article.slug;
    li.addEventListener('click', () => selectArticle(article.slug));
    list.append(li);
  }
  $('#rail-foot').textContent = `${app.articles.length} 篇稿件 · ${app.themes.length} 个主题`;
}

function renderThemes(selected) {
  const select = $('#f-theme');
  const names = [...new Set([...app.themes, selected].filter(Boolean))];
  select.innerHTML = names.map((name) => `<option value="${name}">${name}</option>`).join('');
  select.value = selected || app.themes[0] || '';
}

async function refreshState() {
  const state = await api('/api/state');
  app.articles = state.articles;
  app.themes = state.themes;
  app.env = state.env;
  envChips();
  renderList();
  if (!app.setupPrompted && (!state.env.deps || !state.env.browsers)) {
    app.setupPrompted = true;
    $('#setup-dialog').showModal();
  }
}

/* ---------------------------------- 文章读写 -------------------------------- */

async function selectArticle(slug) {
  if (app.busy) return toast('任务执行中，先等它结束', true);
  if (slug === app.slug) return;
  if (app.dirty) await save();

  const data = await api(`/api/article?slug=${encodeURIComponent(slug)}`);
  app.slug = slug;
  app.dirty = false;

  $('#f-title').value = data.fields.title || '';
  $('#f-author').value = data.fields.author || '';
  $('#f-digest').value = data.fields.digest || '';
  $('#f-markdown').value = data.markdown || '';
  renderThemes(data.fields.theme);
  $('#slug-tag').textContent = slug;
  $('#digest-count').textContent = `${$('#f-digest').value.length}/54`;
  setSaveState('未修改', '');
  renderAssets(data.assets || []);
  renderList();
  loadPreview(slug);
}

function setSaveState(text, kind) {
  const el = $('#save-state');
  el.textContent = text;
  el.className = `save-state mono ${kind}`;
}

function markDirty() {
  app.dirty = true;
  setSaveState('未保存', 'dirty');
  clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(() => save().catch(() => {}), 1200);
}

function fields() {
  return {
    title: $('#f-title').value.trim(),
    author: $('#f-author').value.trim(),
    digest: $('#f-digest').value.trim(),
    theme: $('#f-theme').value,
  };
}

async function save() {
  if (!app.slug) return;
  clearTimeout(app.saveTimer);
  try {
    await api('/api/article', { slug: app.slug, fields: fields(), markdown: $('#f-markdown').value });
    app.dirty = false;
    setSaveState('已保存', 'saved');
    const item = app.articles.find((article) => article.slug === app.slug);
    if (item) {
      item.title = fields().title || '(未命名)';
      item.theme = fields().theme;
      renderList();
    }
  } catch (error) {
    setSaveState('保存失败', 'dirty');
    toast(error.message, true);
    throw error;
  }
}

/* ---------------------------------- 素材 ---------------------------------- */

function renderAssets(assets) {
  const box = $('#assets');
  box.innerHTML = '';
  for (const name of assets) {
    const button = document.createElement('button');
    button.className = 'asset';
    button.title = `插入 ${name}`;
    button.innerHTML = `<img alt=""><span></span>`;
    button.querySelector('img').src = `/content/${app.slug}/assets/${encodeURIComponent(name)}`;
    button.querySelector('span').textContent = name;
    button.addEventListener('click', () => insertAtCursor(`![${name.replace(/\.[^.]+$/, '')}](assets/${name})`));
    box.append(button);
  }
  box.classList.toggle('has', assets.length > 0);
}

function insertAtCursor(text) {
  const area = $('#f-markdown');
  const start = area.selectionStart ?? area.value.length;
  const end = area.selectionEnd ?? area.value.length;
  const before = area.value.slice(0, start);
  const after = area.value.slice(end);
  const pad = before && !before.endsWith('\n') ? '\n' : '';
  area.value = `${before}${pad}${text}\n${after}`;
  area.focus();
  area.selectionStart = area.selectionEnd = (before + pad + text).length + 1;
  markDirty();
}

async function uploadImage(file) {
  if (!app.slug) return toast('先选择或新建一篇文章', true);
  if (!file.type.startsWith('image/')) return;
  const data = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
  const result = await api('/api/asset', { slug: app.slug, name: file.name, data });
  insertAtCursor(`![${file.name.replace(/\.[^.]+$/, '')}](${result.path})`);
  const fresh = await api(`/api/article?slug=${encodeURIComponent(app.slug)}`);
  renderAssets(fresh.assets || []);
  toast(`已存入 ${result.path}`);
}

/* ---------------------------------- 预览 ---------------------------------- */

function loadPreview(slug) {
  const shell = document.querySelector('.preview-shell');
  const frame = $('#preview');
  const article = app.articles.find((item) => item.slug === slug);
  if (!article?.built) {
    shell.classList.remove('ready');
    frame.removeAttribute('src');
    return;
  }
  shell.classList.add('ready');
  frame.src = `/build/${encodeURIComponent(slug)}/preview.html?t=${Date.now()}`;
}

/* ---------------------------------- 任务 ---------------------------------- */

const ACTION_LABEL = { build: '构建预览', draft: '存草稿', publish: '发表', login: '扫码登录', setup: '安装依赖' };

function setBusy(busy) {
  app.busy = busy;
  document.querySelectorAll('[data-action]').forEach((button) => {
    button.disabled = busy;
  });
}

function appendLog(lines) {
  const log = $('#log');
  for (const line of lines) {
    const row = document.createElement('div');
    row.textContent = line;
    if (/^!|失败|错误|Error/.test(line)) row.style.color = '#e8896f';
    if (/^✓|成功|完成/.test(line)) row.style.color = '#9fbf9a';
    log.append(row);
  }
  if (lines.length) {
    app.logLines.push(...lines);
    log.scrollTop = log.scrollHeight;
  }

  const setupLog = $('#setup-log');
  if ($('#setup-dialog').open) {
    setupLog.textContent = app.logLines.slice(-14).join('\n');
    setupLog.scrollTop = setupLog.scrollHeight;
  }
}

async function run(action, extra = {}) {
  if (action !== 'setup' && action !== 'login' && !app.slug) {
    return toast('先选择或新建一篇文章', true);
  }
  if (app.dirty) await save();

  setBusy(true);
  app.jobAction = action;
  app.logLines = [];
  $('#log').textContent = '';
  $('#setup-log').textContent = '';
  app.logCount = 0;
  appendLog([`— ${ACTION_LABEL[action]} —`]);

  try {
    const { id } = await api('/api/action', { action, slug: app.slug, ...extra });
    app.jobId = id;
    switchTab('log');
    pollJob(id);
  } catch (error) {
    setBusy(false);
    toast(error.message, true);
  }
}

async function pollJob(id) {
  const job = await api(`/api/job?id=${id}`);
  if (job.logs.length > app.logCount) {
    appendLog(job.logs.slice(app.logCount));
    app.logCount = job.logs.length;
  }

  if (job.status === 'queued' || job.status === 'running') {
    setTimeout(() => pollJob(id), 700);
    return;
  }

  setBusy(false);
  await refreshState();

  if (job.status === 'error') {
    toast(`${ACTION_LABEL[app.jobAction]}失败：${job.error}`, true);
    appendLog([`✗ ${job.error}`]);
    return;
  }

  const result = job.result || {};
  if (app.jobAction === 'build') {
    appendLog([`✓ 构建完成 · ${(result.size / 1024).toFixed(1)}KB`]);
    loadPreview(app.slug);
    switchTab('preview');
    toast('构建完成');
  } else if (app.jobAction === 'draft') {
    appendLog([
      `封面：${result.cover?.ok ? '已从正文选择' : `失败（${result.cover?.reason || '未知'}）`}`,
      '✓ 草稿已保存',
    ]);
    toast('草稿已保存');
  } else if (app.jobAction === 'publish') {
    if (!result.publish?.executed) {
      appendLog([`· 未提交：${result.publish?.reason || '未执行'}`]);
    } else {
      appendLog([
        `群发通知：${result.publish.groupSendOff ? '已关闭' : '未关闭，请检查后台'}`,
        result.publish.ok ? '✓ 发表成功' : '· 已提交，但未检测到成功提示',
      ]);
      toast(result.publish.ok ? '发表成功' : '已提交，请到后台确认');
    }
  } else if (app.jobAction === 'login') {
    appendLog(['✓ 登录态已保存']);
    toast('登录成功');
  } else if (app.jobAction === 'setup') {
    $('#setup-dialog').close();
    appendLog(['✓ 依赖安装完成']);
    toast('依赖已就绪');
  }
}

/* ---------------------------------- 交互绑定 -------------------------------- */

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === name);
  });
  document.querySelectorAll('.pane').forEach((pane) => {
    pane.classList.toggle('active', pane.id === `pane-${name}`);
  });
}

function bind() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.action;
      if (action === 'publish') return $('#publish-dialog').showModal();
      run(action);
    });
  });

  $('#publish-confirm').addEventListener('click', () => run('publish', { execute: true }));

  $('#new-article').addEventListener('click', () => {
    $('#new-slug').value = '';
    $('#new-dialog').showModal();
  });

  $('#new-create').addEventListener('click', async (event) => {
    event.preventDefault();
    const slug = $('#new-slug').value.trim();
    if (!slug) return toast('先填一个目录名', true);
    try {
      await api('/api/article', {
        create: true,
        slug,
        fields: { title: '', theme: app.themes[0] },
        markdown: '',
      });
      $('#new-dialog').close();
      await refreshState();
      await selectArticle(slug);
      $('#f-title').focus();
      toast(`已创建 ${slug}`);
    } catch (error) {
      toast(error.message, true);
    }
  });

  $('#setup-run').addEventListener('click', (event) => {
    event.preventDefault();
    run('setup');
  });

  for (const id of ['#f-title', '#f-author', '#f-digest']) {
    $(id).addEventListener('input', markDirty);
  }
  $('#f-theme').addEventListener('change', markDirty);
  $('#f-markdown').addEventListener('input', markDirty);
  $('#f-digest').addEventListener('input', () => {
    $('#digest-count').textContent = `${$('#f-digest').value.length}/54`;
  });

  $('#import-md').addEventListener('click', () => $('#md-input').click());
  $('#md-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    $('#f-markdown').value = text;
    markDirty();
    toast(`已导入 ${file.name}`);
    event.target.value = '';
  });

  $('#pick-image').addEventListener('click', () => $('#img-input').click());
  $('#img-input').addEventListener('change', async (event) => {
    for (const file of event.target.files || []) {
      await uploadImage(file).catch((error) => toast(error.message, true));
    }
    event.target.value = '';
  });

  const area = $('#f-markdown');
  area.addEventListener('dragover', (event) => {
    event.preventDefault();
    area.classList.add('dragover');
  });
  area.addEventListener('dragleave', () => area.classList.remove('dragover'));
  area.addEventListener('drop', async (event) => {
    event.preventDefault();
    area.classList.remove('dragover');
    for (const file of event.dataTransfer?.files || []) {
      if (/\.(md|markdown)$/i.test(file.name)) {
        area.value = await file.text();
        markDirty();
      } else if (file.type.startsWith('image/')) {
        await uploadImage(file).catch((error) => toast(error.message, true));
      }
    }
  });

  area.addEventListener('paste', async (event) => {
    const image = [...(event.clipboardData?.items || [])]
      .find((item) => item.type.startsWith('image/'))
      ?.getAsFile();
    if (!image) return;
    event.preventDefault();
    await uploadImage(image).catch((error) => toast(error.message, true));
  });

  window.addEventListener('beforeunload', (event) => {
    if (app.dirty) event.preventDefault();
  });
}

async function boot() {
  bind();
  try {
    await refreshState();
    const first = app.articles[0];
    if (first) await selectArticle(first.slug);
  } catch (error) {
    toast(`无法连接本地服务：${error.message}`, true);
  }
}

boot();
