const $ = (selector) => document.querySelector(selector);

const app = {
  articles: [],
  themes: {},
  themeDefaults: {},
  platforms: [],
  env: {},
  slug: null,
  articleFields: {},
  themeSelection: {},
  assets: [],
  coverPath: '',
  tagTimer: null,
  dirty: false,
  busy: false,
  saveTimer: null,
  jobId: null,
  jobAction: null,
  publishPlatform: null,
  platformId: localStorage.getItem('plat') || null,
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

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
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

function selectedPlatform() {
  return app.platforms.find((platform) => platform.id === app.platformId) || null;
}

/** 当前平台是否使用主题；返回平台 id 或空字符串 */
function themePlatform() {
  const platform = selectedPlatform();
  return platform?.theme ? platform.id : '';
}

function themeNames(platform) {
  return app.themes[platform] || [];
}

const THEME_HELP = {
  wechat: [
    '微信公众号主题：UTF-8 编码的纯 CSS 文件，单个文件，不超过 200KB。',
    '选择器：必须写在 #nice 下，例如 #nice h2 { ... }、#nice p { ... }。',
    '可用属性：字体、字号、字重、颜色、背景色/渐变、边框、圆角、内外边距、行高、字距、对齐、文本装饰。',
    '构建时会自动展开 CSS 变量，并把规则逐条内联到正文元素上。',
    '以下内容会被移除或无法生效：伪元素（::before/::after）、:hover 等交互态、@media、@import、外链字体和图片、position、float、flex/grid、动画、transform、filter。',
    '提示：微信编辑器不认 <style>，只有内联后依然有效的属性才能保留。',
    '点击「?」可复制一份主题设计提示词，直接粘贴给 AI 使用。',
  ].join('\n'),
  zhihu: [
    '知乎主题：UTF-8 编码的纯 CSS 文件，单个文件，不超过 200KB。',
    '选择器：必须写在 #nice 下，例如 #nice h2 { ... }、#nice p { ... }。',
    '可用属性：字体、字号、字重、颜色、背景、边框、圆角、内外边距、行高、字距、对齐等常规排版属性。',
    '构建时会自动展开 CSS 变量，并逐条内联后粘贴到知乎编辑器。',
    '以下内容会被移除或无法生效：伪元素、:hover 等交互态、@media、@import、外链字体和图片、position、flex/grid、动画、transform、filter。',
    '提示：知乎编辑器粘贴时会重新解析 HTML 并清洗部分样式，复杂布局不保证保留；基础字体/行高建议同时写到 #nice p、#nice li 上。',
    '点击「?」可复制一份主题设计提示词，直接粘贴给 AI 使用。',
  ].join('\n'),
};

/** 点击问号复制给 AI 的主题设计提示词，按平台补充对应限制 */
function themePrompt(platform) {
  const isZhihu = platform === 'zhihu';
  const platformName = isZhihu ? '知乎' : '微信公众号';
  return [
    `你是一位熟悉${platformName}排版的 CSS 设计师。请为${platformName}文章设计一套排版主题，只输出一个完整的 .css 文件，不要输出任何解释。`,
    '',
    '【输出要求】',
    '1. UTF-8 编码的纯 CSS，单个文件，不超过 200KB。',
    '2. 所有选择器必须写在 #nice 下（正文容器 id="nice"），例如 #nice h2 { ... }、#nice p { ... }；不要使用 :root、html、body 等全局选择器。',
    '3. 只使用这些属性：font-family、font-size、font-weight、font-style、color、background-color、background-image（渐变）、border、border-radius、margin、padding、line-height、letter-spacing、text-align、text-decoration。',
    '4. 不要使用伪元素（::before/::after）、:hover 等交互伪类、@media、@import、外链字体和图片、position、float、flex、grid、动画、transform、filter；这些会被移除或无法生效。',
    '5. 可以使用 CSS 变量，但变量要声明在 #nice 内，构建时会展开为字面值。',
    isZhihu
      ? '6. 知乎编辑器粘贴时会重新解析 HTML，最外层容器可能被丢弃；基础字体、字号、行高要同时写到 #nice p、#nice li 上，以排版、配色、间距为主，避免复杂布局。'
      : '6. 公众号编辑器只接受内联样式，效果必须在展开变量、逐条内联后依然可见。',
    '7. 覆盖元素：h1、h2、h3、h4、p、strong、em、blockquote、ul、ol、li、a、code、pre、table、th、td、img、hr。',
    '',
    '【我的需求】',
    '风格关键词：（例如：极简、杂志感、暖色、科技蓝）',
    '主色：（例如：#ff6a29）',
    '适用内容类型：（例如：技术教程、产品评测、生活随笔）',
    '其他要求：（例如：标题更醒目、代码块用深色）',
  ].join('\n');
}

/** 按当前平台重建主题下拉、导入按钮与说明 */
function renderThemeField() {
  const platform = selectedPlatform();
  const platformId = themePlatform();
  const select = $('#f-theme');
  const importBtn = $('#theme-import');
  const helpWrap = $('#theme-help').closest('.theme-help-wrap');
  const note = $('#theme-note');

  select.disabled = !platformId;
  importBtn.hidden = !platformId;
  helpWrap.hidden = !platformId;

  if (!platformId) {
    select.innerHTML = '<option>平台自带排版（主题不生效）</option>';
    const tip = $('#theme-tip');
    tip.textContent = '';
    tip.classList.remove('show');
    note.textContent = platform
      ? `${platform.name} 使用 Markdown 原文粘贴，排版由平台负责，主题不生效。`
      : '';
    return;
  }

  const names = themeNames(platformId);
  const current =
    app.themeSelection[platformId] || app.themeDefaults[platformId] || names[0] || '';
  const options = [...new Set([...names, current].filter(Boolean))];

  select.innerHTML = '';
  for (const name of options) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    select.append(option);
  }
  select.value = current;
  app.themeSelection[platformId] = select.value;

  $('#theme-tip').textContent = THEME_HELP[platformId] || '';
  note.textContent =
    platformId === 'wechat'
      ? '当前平台：微信公众号；构建预览、存草稿、发布都会使用这个主题。'
      : `${platform.name} 主题在发布粘贴正文时生效。`;
}

function renderPlatforms() {
  const grid = $('#platforms');
  const keyword = $('#plat-filter').value.trim().toLowerCase();
  const shown = app.platforms.filter(
    (platform) =>
      !keyword ||
      platform.name.toLowerCase().includes(keyword) ||
      platform.id.toLowerCase().includes(keyword),
  );

  if (!app.platforms.some((platform) => platform.id === app.platformId)) {
    app.platformId = (app.platforms.find((platform) => platform.auth) || app.platforms[0] || {}).id || null;
    localStorage.setItem('plat', app.platformId || '');
  }

  grid.innerHTML = '';
  for (const platform of shown) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `plat-chip ${platform.auth ? 'authed' : ''} ${
      platform.id === app.platformId ? 'selected' : ''
    }`;
    chip.dataset.platform = platform.id;
    chip.title = `${platform.name} · ${platform.auth ? '已登录' : '未登录'}`;
    chip.innerHTML = `<span class="p-dot"></span><span class="p-name"></span>`;
    chip.querySelector('.p-name').textContent = platform.name;
    grid.append(chip);
  }

  $('#plat-count').textContent = keyword
    ? `${shown.length}/${app.platforms.length}`
    : `${app.platforms.length} 个平台`;
  renderPlatformBar();
  renderThemeField();
}

function renderPlatformBar() {
  const platform = selectedPlatform();
  const current = $('#plat-current');
  current.textContent = platform ? platform.name : '未选择平台';
  current.classList.toggle('authed', Boolean(platform?.auth));

  const box = $('#plat-actions');
  box.innerHTML = '';
  if (!platform) return;

  const buttons = [];
  if (!platform.auth) buttons.push({ action: 'login', text: '登录' });
  if (platform.id === 'wechat') buttons.push({ action: 'draft', text: '存草稿' });
  if (platform.auth) buttons.push({ action: 'open', text: '后台' });
  buttons.push({ action: 'publish', text: '发布', primary: true });

  for (const item of buttons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `pbtn ${item.primary ? 'primary' : ''}`;
    button.dataset.platAction = item.action;
    button.textContent = item.text;
    button.disabled = app.busy;
    box.append(button);
  }
}

function renderList() {
  const list = $('#articles');
  list.innerHTML = '';
  for (const article of app.articles) {
    const li = document.createElement('li');
    li.className = `${article.slug === app.slug ? 'active' : ''} ${article.built ? 'built' : ''}`;
    li.innerHTML = `<span class="t"></span><span class="s"></span><button class="del" type="button" title="删除稿件">×</button>`;
    li.querySelector('.t').textContent = article.title || article.slug;
    li.querySelector('.s').textContent = article.slug;
    li.addEventListener('click', () => selectArticle(article.slug));
    li.querySelector('.del').addEventListener('click', (event) => {
      event.stopPropagation();
      removeArticle(article.slug);
    });
    list.append(li);
  }
  $('#rail-foot').textContent = `${app.articles.length} 篇稿件 · ${Object.values(app.themes).reduce(
    (sum, names) => sum + names.length,
    0,
  )} 个主题`;
}

async function refreshState() {
  const state = await api('/api/state');
  app.articles = state.articles;
  app.themes = state.themes || {};
  app.themeDefaults = state.themeDefaults || {};
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
  app.themeSelection = {};
  for (const platform of Object.keys(app.themes)) {
    const value =
      data.fields.themes?.[platform] || (platform === 'wechat' ? data.fields.theme : '');
    if (value) app.themeSelection[platform] = value;
  }
  renderThemeField();
  $('#slug-tag').textContent = slug;
  $('#digest-count').textContent = `${$('#f-digest').value.length}/54`;
  setSaveState('未修改', '');
  renderAssets(data.assets || []);
  renderList();
  loadPreview(slug);
}

/** 构建可能压缩并改名图片，构建后把磁盘上的正文和素材重新拉回编辑器 */
async function syncArticleFiles() {
  if (!app.slug) return;
  const data = await api(`/api/article?slug=${encodeURIComponent(app.slug)}`);
  $('#f-markdown').value = data.markdown || '';
  app.assets = data.assets || [];
  app.dirty = false;
  renderAssets(app.assets);
  setSaveState('已同步', 'saved');
}

/** 清空编辑区，用于删除当前稿件后回到空状态 */
function resetEditor() {
  app.slug = null;
  app.articleFields = {};
  app.themeSelection = {};
  app.assets = [];
  app.dirty = false;
  $('#f-title').value = '';
  $('#f-author').value = '';
  $('#f-digest').value = '';
  $('#f-markdown').value = '';
  $('#slug-tag').textContent = '—';
  $('#digest-count').textContent = '0/54';
  renderThemeField();
  renderAssets([]);
  setSaveState('未修改', '');
  loadPreview(null);
}

async function removeArticle(slug) {
  if (app.busy) return toast('任务执行中，先等它结束', true);
  const title = app.articles.find((article) => article.slug === slug)?.title || slug;
  if (!window.confirm(`删除稿件「${title}」？目录、图片和构建产物会一起删掉，无法恢复。`)) return;

  try {
    const { id } = await api('/api/action', { action: 'remove', slug });
    await waitJob(id);
    if (app.slug === slug) resetEditor();
    await refreshState();
    toast(`已删除 ${slug}`);
  } catch (error) {
    toast(error.message, true);
  }
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
  const themes = { ...app.themeSelection };
  const result = {
    title: $('#f-title').value.trim(),
    author: $('#f-author').value.trim(),
    digest: $('#f-digest').value.trim(),
    themes,
  };
  if (themes.wechat) result.theme = themes.wechat;
  return result;
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
      renderList();
    }
  } catch (error) {
    setSaveState('保存失败', 'dirty');
    toast(error.message, true);
    throw error;
  }
}

/* ---------------------------------- 素材 ---------------------------------- */

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function renderAssets(assets) {
  const box = $('#assets');
  box.innerHTML = '';
  for (const name of assets) {
    const item = document.createElement('div');
    item.className = 'asset';

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'asset-pick';
    pick.title = `插入 ${name}`;
    pick.innerHTML = '<img alt=""><span></span>';
    pick.querySelector('img').src = `/content/${app.slug}/assets/${encodeURIComponent(name)}`;
    pick.querySelector('span').textContent = name;
    pick.addEventListener('click', () =>
      insertAtCursor(`![${name.replace(/\.[^.]+$/, '')}](assets/${name})`),
    );

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'asset-del';
    remove.title = `删除 ${name}`;
    remove.textContent = '×';
    remove.addEventListener('click', () => removeAsset(name));

    item.append(pick, remove);
    box.append(item);
  }
  box.classList.toggle('has', assets.length > 0);
}

/** 删除素材图，并把正文里对它的引用一并清掉 */
async function removeAsset(name) {
  if (app.busy) return toast('任务执行中，先等它结束', true);
  if (!app.slug) return;
  if (!window.confirm(`删除图片「${name}」？正文里对它的引用会一并清理。`)) return;

  try {
    const area = $('#f-markdown');
    const pattern = escapeRegExp(name);
    const cleaned = area.value
      .replace(
        new RegExp(`!\\[[^\\]]*\\]\\(\\s*(?:\\.\\/)?assets/${pattern}(?:\\s+"[^"]*")?\\s*\\)[ \\t]*\\n?`, 'g'),
        '',
      )
      .replace(new RegExp(`<img\\b[^>]*?\\ssrc="(?:\\.\\/)?assets/${pattern}"[^>]*>[ \\t]*\\n?`, 'g'), '');
    if (cleaned !== area.value) {
      area.value = cleaned;
      app.dirty = true;
      await save();
    }

    await api('/api/asset/remove', { slug: app.slug, name });
    const fresh = await api(`/api/article?slug=${encodeURIComponent(app.slug)}`);
    app.assets = fresh.assets || [];
    renderAssets(app.assets);
    toast(`已删除 ${name}`);
  } catch (error) {
    toast(error.message, true);
  }
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
    // 构建失败也可能已经压缩并改名了图片，把最新引用拉回来避免下次再撞「图片不存在」
    if (app.jobAction === 'build') await syncArticleFiles().catch(() => {});
    return;
  }

  const result = job.result || {};
  if (app.jobAction === 'build') {
    appendLog([`✓ 构建完成 · ${(result.size / 1024).toFixed(1)}KB`]);
    if (result.renamed) {
      await syncArticleFiles().catch(() => {});
      appendLog([`· 已同步 ${result.renamed} 处图片引用`]);
      toast('构建完成，图片引用已同步');
    } else {
      toast('构建完成');
    }
    loadPreview(app.slug);
    switchTab('preview');
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
  const article = app.articles.find((item) => item.slug === app.slug);
  if (!article?.built) return toast('这篇文章还没有构建，请先构建预览再发布', true);
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
    button.addEventListener('click', () => {
      const action = button.dataset.action;
      // 构建时按当前选中的平台决定图片上限
      run(action, action === 'build' ? { platform: app.platformId || 'wechat' } : {});
    });
  });

  $('#platforms').addEventListener('click', (event) => {
    const chip = event.target.closest('.plat-chip');
    if (!chip) return;
    app.platformId = chip.dataset.platform;
    localStorage.setItem('plat', app.platformId);
    renderPlatforms();
  });

  $('#plat-filter').addEventListener('input', () => renderPlatforms());

  $('#plat-actions').addEventListener('click', (event) => {
    const button = event.target.closest('[data-plat-action]');
    if (!button || !app.platformId) return;
    const action = button.dataset.platAction;
    if (action === 'publish') {
      openPublishDialog(app.platformId);
    } else {
      run(action, { platform: app.platformId });
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
        fields: { title: '', themes: {} },
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
  $('#f-theme').addEventListener('change', () => {
    const platform = themePlatform();
    if (platform) app.themeSelection[platform] = $('#f-theme').value;
    markDirty();
  });
  const themeHelp = $('#theme-help');
  const themeTip = $('#theme-tip');
  // 挂到 body 上，避免被编辑区（有入场动画/overflow）裁剪或改变 fixed 定位基准
  document.body.append(themeTip);
  const showThemeTip = () => {
    const field = themeHelp.closest('.theme-field');
    if (!field || !themeTip.textContent) return;
    const fieldRect = field.getBoundingClientRect();
    const width = Math.min(520, window.innerWidth - 32);
    themeTip.style.width = `${width}px`;
    themeTip.style.left = '0px';
    themeTip.style.top = '0px';
    themeTip.classList.add('show');

    const height = themeTip.getBoundingClientRect().height;
    const left = Math.min(
      Math.max(16, fieldRect.right - width),
      window.innerWidth - width - 16,
    );
    let top = fieldRect.bottom + 6;
    if (top + height > window.innerHeight - 12) {
      top = Math.max(12, fieldRect.top - height - 6);
    }
    themeTip.style.left = `${Math.round(left)}px`;
    themeTip.style.top = `${Math.round(top)}px`;
  };
  const hideThemeTip = () => themeTip.classList.remove('show');
  themeHelp.addEventListener('mouseenter', showThemeTip);
  themeHelp.addEventListener('focus', showThemeTip);
  themeHelp.addEventListener('mouseleave', hideThemeTip);
  themeHelp.addEventListener('blur', hideThemeTip);
  themeHelp.addEventListener('click', async () => {
    const platform = themePlatform();
    if (!platform) return;
    const copied = await copyText(themePrompt(platform));
    toast(
      copied ? '已复制主题设计提示词，可粘贴给 AI 使用' : '复制失败，请手动选择提示词',
      !copied,
    );
  });
  window.addEventListener('scroll', hideThemeTip, true);
  window.addEventListener('resize', hideThemeTip);
  $('#theme-import').addEventListener('click', () => {
    if (!themePlatform()) return;
    $('#theme-input').click();
  });
  $('#theme-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    const platform = themePlatform();
    if (!file || !platform) return;
    if (file.size > 200 * 1024) return toast('主题 CSS 不能超过 200KB', true);
    try {
      const result = await api('/api/theme/import', {
        platform,
        filename: file.name,
        css: await file.text(),
      });
      app.themeSelection[platform] = result.id;
      await refreshState();
      renderThemeField();
      markDirty();
      toast(`已导入主题 ${result.id}`);
    } catch (error) {
      toast(error.message, true);
    }
  });
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
    const wanted = new URLSearchParams(location.search).get('slug');
    const target = app.articles.find((article) => article.slug === wanted) || app.articles[0];
    if (target) await selectArticle(target.slug);
    if (wanted && !app.articles.some((article) => article.slug === wanted)) {
      toast(`稿件 ${wanted} 不存在`, true);
    }
  } catch (error) {
    toast(`无法连接本地服务：${error.message}`, true);
  }
}

boot();
