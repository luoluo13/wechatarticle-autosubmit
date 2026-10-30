const $ = (selector) => document.querySelector(selector);

const app = {
  articles: [],
  themes: [],
  platforms: [],
  env: {},
  slug: null,
  articleFields: {},
  assets: [],
  coverPath: '',
  tagTimer: null,
  dirty: false,
  busy: false,
  saveTimer: null,
  jobId: null,
  jobAction: null,
  publishPlatform: null,
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
  const authed = app.platforms.filter((platform) => platform.auth).length;
  const chips = [
    { text: `node ${env.node || '?'}`, state: '' },
    { text: env.deps ? '依赖已装' : '依赖缺失', state: env.deps ? '' : 'off' },
    { text: env.browsers ? '浏览器已装' : '浏览器缺失', state: env.browsers ? '' : 'off' },
    {
      text: `已登录 ${authed}/${app.platforms.length}`,
      state: authed === app.platforms.length ? '' : 'warn',
    },
  ];
  $('#env').innerHTML = chips
    .map((chip) => `<span class="chip ${chip.state}">${chip.text}</span>`)
    .join('');
}

function renderPlatforms() {
  const box = $('#platforms');
  box.innerHTML = '';
  for (const platform of app.platforms) {
    const card = document.createElement('div');
    card.className = `platform ${platform.auth ? 'authed' : ''}`;
    card.dataset.platform = platform.id;
    card.innerHTML = `
      <span class="p-dot" title="${platform.auth ? '已登录' : '未登录'}"></span>
      <span class="p-name"></span>
      <span class="p-actions">
        ${platform.id === 'wechat' ? '<button class="pbtn" data-plat-action="draft">存草稿</button>' : ''}
        <button class="pbtn" data-plat-action="${platform.auth ? 'open' : 'login'}">${platform.auth ? '后台' : '登录'}</button>
        <button class="pbtn primary" data-plat-action="publish">发布</button>
      </span>`;
    card.querySelector('.p-name').textContent = platform.name;
    box.append(card);
  }
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
  app.platforms = state.platforms || [];
  app.env = state.env;
  envChips();
  renderList();
  renderPlatforms();
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
  app.articleFields = data.fields || {};
  app.assets = data.assets || [];
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

async function saveAsset(file) {
  if (!app.slug) throw new Error('先选择或新建一篇文章');
  if (!file.type.startsWith('image/')) throw new Error('只支持图片文件');
  const data = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
  return api('/api/asset', { slug: app.slug, name: file.name, data });
}

async function uploadImage(file) {
  if (!app.slug) return toast('先选择或新建一篇文章', true);
  if (!file.type.startsWith('image/')) return;
  const result = await saveAsset(file);
  insertAtCursor(`![${file.name.replace(/\.[^.]+$/, '')}](${result.path})`);
  const fresh = await api(`/api/article?slug=${encodeURIComponent(app.slug)}`);
  app.assets = fresh.assets || [];
  renderAssets(app.assets);
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

const ACTION_LABEL = {
  build: '构建预览',
  draft: '存草稿',
  publish: '发布',
  login: '登录',
  loginAll: '全部登录',
  open: '打开后台',
  setup: '安装依赖',
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setBusy(busy) {
  app.busy = busy;
  document.querySelectorAll('[data-action], [data-plat-action]').forEach((button) => {
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
  if (['build', 'draft', 'publish'].includes(action) && !app.slug) {
    return toast('先选择或新建一篇文章', true);
  }
  if (app.dirty && action !== 'loginAll' && action !== 'open') await save();

  setBusy(true);
  app.jobAction = action;
  app.publishPlatform = extra.platform || null;
  app.logLines = [];
  $('#log').textContent = '';
  $('#setup-log').textContent = '';
  app.logCount = 0;

  const platformName = extra.platform
    ? app.platforms.find((item) => item.id === extra.platform)?.name
    : '';
  appendLog([`— ${ACTION_LABEL[action] || action}${platformName ? ` · ${platformName}` : ''} —`]);

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

async function waitJob(id, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const job = await api(`/api/job?id=${id}`);
    if (job.status === 'done') return job.result || {};
    if (job.status === 'error') throw new Error(job.error || '任务失败');
    await delay(700);
  }
  throw new Error('等待任务超时');
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
    if (app.publishPlatform === 'wechat') {
      if (!result.publish?.executed) {
        appendLog([`· 未提交：${result.publish?.reason || '未执行'}`]);
        toast('未提交');
      } else {
        appendLog([
          `群发通知：${result.publish.groupSendOff ? '已关闭' : '未关闭，请检查后台'}`,
          result.publish.ok ? '✓ 发表成功' : '· 已提交，但未检测到成功提示',
        ]);
        toast(result.publish.ok ? '发表成功' : '已提交，请到后台确认');
      }
    } else if (result.ok) {
      appendLog([`✓ 已发布${result.url ? `：${result.url}` : ''}`]);
      toast('发布成功');
    } else {
      appendLog([`· 未能确认发布结果${result.url ? `：${result.url}` : ''}`]);
      toast('已提交，请到平台确认');
    }
    if (result.note) appendLog([`· ${result.note}`]);
  } else if (app.jobAction === 'login') {
    appendLog(['✓ 登录态已保存']);
    toast('登录成功');
  } else if (app.jobAction === 'loginAll') {
    const saved = result.saved || [];
    const pending = result.pending || [];
    appendLog([
      `✓ 已登录：${saved.join(' / ') || '无'}`,
      ...(pending.length ? [`! 未登录：${pending.join(' / ')}`] : []),
    ]);
    toast(pending.length ? `还有 ${pending.length} 个平台未登录` : '全部平台已登录');
  } else if (app.jobAction === 'open') {
    appendLog([`✓ 已打开 ${result.homeUrl || '平台后台'}`]);
    toast('已在浏览器打开后台');
  } else if (app.jobAction === 'setup') {
    $('#setup-dialog').close();
    appendLog(['✓ 依赖安装完成']);
    toast('依赖已就绪');
  }
}

/* ---------------------------------- 发布弹窗 ------------------------------ */

function splitTags(value) {
  return [
    ...new Set(
      String(value || '')
        .split(/[,，、#]+/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

function currentTags() {
  return Array.isArray(app.articleFields.tags)
    ? app.articleFields.tags
    : splitTags(app.articleFields.tags);
}

async function openPublishDialog(platformId) {
  if (app.busy) return toast('任务执行中，先等它结束', true);
  if (!app.slug) return toast('先选择或新建一篇文章', true);
  if (app.dirty) await save();

  const platform = app.platforms.find((item) => item.id === platformId);
  if (!platform) return;

  const spec = platform.optionsSpec || {};
  app.publishPlatform = platformId;
  app.coverPath = '';

  $('#pd-name').textContent = platform.name;
  $('#pd-category-field').hidden = !spec.category;
  $('#pd-category-req').textContent = spec.category === 'required' ? '必选' : '选填';
  $('#pd-tags-field').hidden = !spec.tags;
  $('#pd-tags-hint').textContent = [
    spec.tagsMax ? `最多 ${spec.tagsMax} 个` : '',
    platform.tagSuggest ? '点下方候选直接加入' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  $('#pd-tags').value = currentTags().join(', ');
  $('#pd-tags-suggest').hidden = true;
  $('#pd-cover-field').hidden = !spec.cover;
  $('#pd-cover-hint').textContent =
    spec.cover === 'body' ? '只能选正文图片' : '可选文章图片或导入';
  $('#pd-hint').textContent =
    platformId === 'wechat'
      ? '自动处理创作来源声明并关闭群发通知；若弹出微信验证二维码，需要你扫码。'
      : '脚本会打开平台编辑器，填好标题、正文并逐张上传图片，然后直接发布。';

  $('#publish-dialog').showModal();
  if (spec.cover) renderCoverPicker(platform);
  if (spec.category) await loadPlatformOptions(platformId);
  if (spec.tags && platform.tagSuggest) loadTagSuggestions(true).catch(() => {});
}

/* ---------------------------------- 标签候选 ------------------------------- */

function addTag(tag) {
  const platform = app.platforms.find((item) => item.id === app.publishPlatform);
  const max = platform?.optionsSpec?.tagsMax;
  const tags = splitTags($('#pd-tags').value);
  if (tags.includes(tag)) return;
  if (max && tags.length >= max) return toast(`标签最多 ${max} 个`, true);
  tags.push(tag);
  $('#pd-tags').value = tags.join(', ');
  scheduleTagSuggest();
}

function renderTagSuggest(tags) {
  const box = $('#pd-tags-suggest');
  const platform = app.platforms.find((item) => item.id === app.publishPlatform);
  const max = platform?.optionsSpec?.tagsMax;
  const existing = splitTags($('#pd-tags').value);
  const list = tags.filter((tag) => !existing.includes(tag)).slice(0, 12);
  box.innerHTML = '';

  if (max && existing.length >= max) {
    const note = document.createElement('span');
    note.className = 'hint';
    note.textContent = `已达标签上限（${max} 个），删掉一个再加`;
    box.append(note);
    box.hidden = false;
    return;
  }

  if (!list.length) {
    box.hidden = true;
    return;
  }
  for (const tag of list) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tag-chip';
    button.textContent = tag;
    button.addEventListener('click', () => addTag(tag));
    box.append(button);
  }
  box.hidden = false;
}

function scheduleTagSuggest(wait = 400) {
  clearTimeout(app.tagTimer);
  app.tagTimer = setTimeout(() => loadTagSuggestions().catch(() => {}), wait);
}

async function loadTagSuggestions(hot = false) {
  const platform = app.platforms.find((item) => item.id === app.publishPlatform);
  const box = $('#pd-tags-suggest');
  if (!platform?.tagSuggest) return;
  box.hidden = true;

  // 打开弹窗时先拉平台热门标签；输入后只拿最后一个还没分隔的词去搜
  const keyword = hot ? '' : $('#pd-tags').value.split(/[,，、#]+/).pop().trim();
  const { id } = await api('/api/action', {
    action: 'tags',
    platform: platform.id,
    keyword,
  });
  const result = await waitJob(id);
  if (app.publishPlatform !== platform.id) return;
  renderTagSuggest(result.tags || []);
}

/* ---------------------------------- 封面选择 ------------------------------- */

function coverFileName(path) {
  return String(path || '').replace(/^assets\//, '');
}

function bodyAssets() {
  const markdown = $('#f-markdown').value;
  return app.assets.filter((name) => markdown.includes(name));
}

function renderCoverPicker(platform) {
  const spec = platform.optionsSpec || {};
  const box = $('#pd-cover-list');
  const names = spec.cover === 'body' ? bodyAssets() : [...app.assets];
  if (app.coverPath && !names.includes(coverFileName(app.coverPath))) {
    names.push(coverFileName(app.coverPath));
  }

  if (!app.coverPath) {
    const preferred = coverFileName(app.articleFields.cover);
    if (preferred && names.includes(preferred)) app.coverPath = `assets/${preferred}`;
    else if (spec.cover !== 'body' && names.includes('cover.png')) app.coverPath = 'assets/cover.png';
    else if (spec.cover === 'body' && names.length) app.coverPath = `assets/${names[0]}`;
  }

  box.innerHTML = '';
  if (!names.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = spec.cover === 'body' ? '正文里还没有图片' : '文章里还没有图片素材';
    box.append(empty);
  }

  for (const name of names) {
    const value = `assets/${name}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `cover-item ${app.coverPath === value ? 'picked' : ''}`;
    button.innerHTML = `<img alt=""><span></span>`;
    button.querySelector('img').src = `/content/${encodeURIComponent(app.slug)}/assets/${encodeURIComponent(name)}`;
    button.querySelector('span').textContent = name;
    button.addEventListener('click', () => {
      app.coverPath = app.coverPath === value ? '' : value;
      renderCoverPicker(platform);
    });
    box.append(button);
  }

  $('#pd-cover-note').textContent = app.coverPath
    ? `已选：${coverFileName(app.coverPath)}`
    : '不选则用文章默认封面';
}

async function importCover(file) {
  const platform = app.platforms.find((item) => item.id === app.publishPlatform);
  if (!platform) return;
  const result = await saveAsset(file);
  const name = coverFileName(result.path);
  if (!app.assets.includes(name)) app.assets.push(name);
  app.coverPath = result.path;
  renderCoverPicker(platform);
  toast(`已导入 ${result.path}`);
}

async function loadPlatformOptions(platformId) {
  const select = $('#pd-category');
  const confirm = $('#publish-confirm');
  select.innerHTML = '<option value="">读取分类中…</option>';
  confirm.disabled = true;

  try {
    const { id } = await api('/api/action', { action: 'options', platform: platformId });
    const result = await waitJob(id);
    const categories = (result.categories || []).map((item) =>
      typeof item === 'string' ? { value: item, label: item } : item,
    );

    select.innerHTML = '';
    if (!categories.length) {
      select.innerHTML = '<option value="">平台没有返回分类</option>';
      return;
    }
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '请选择分类';
    select.append(placeholder);
    for (const category of categories) {
      const option = document.createElement('option');
      option.value = category.value;
      option.textContent = category.label;
      select.append(option);
    }
    if (categories.length === 1) select.value = categories[0].value;
  } catch (error) {
    select.innerHTML = '<option value="">读取失败，可稍后重试</option>';
    toast(`分类读取失败：${error.message}`, true);
  } finally {
    confirm.disabled = false;
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
    button.addEventListener('click', () => run(button.dataset.action));
  });

  $('#platforms').addEventListener('click', (event) => {
    const button = event.target.closest('[data-plat-action]');
    if (!button) return;
    const platformId = button.closest('.platform')?.dataset.platform;
    if (!platformId) return;
    const action = button.dataset.platAction;
    if (action === 'publish') {
      openPublishDialog(platformId);
    } else if (action === 'draft') {
      run('draft');
    } else {
      run(action, { platform: platformId });
    }
  });

  $('#publish-confirm').addEventListener('click', (event) => {
    event.preventDefault();
    const platform = app.platforms.find((item) => item.id === app.publishPlatform);
    if (!platform) return;

    const spec = platform.optionsSpec || {};
    const category = $('#pd-category').value.trim();
    const tags = splitTags($('#pd-tags').value);
    if (spec.category === 'required' && !category) return toast('请先选择分类 / 板块', true);
    if (spec.tags === 'required' && !tags.length) return toast('请至少填一个标签', true);
    if (spec.tagsMax && tags.length > spec.tagsMax) {
      return toast(`标签最多 ${spec.tagsMax} 个`, true);
    }

    $('#publish-dialog').close();
    run('publish', {
      platform: platform.id,
      execute: true,
      options: { category, tags, cover: app.coverPath },
    });
  });

  $('#pd-tags').addEventListener('input', () => scheduleTagSuggest());

  $('#pd-cover-import').addEventListener('click', () => $('#pd-cover-input').click());
  $('#pd-cover-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await importCover(file).catch((error) => toast(error.message, true));
  });

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
