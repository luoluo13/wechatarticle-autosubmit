# autosubmit-wechatarticle

把本地 Markdown 渲染成「可直接粘贴进公众号后台」的图文，并通过浏览器自动化完成填稿、选封面、保存草稿与发表。

面向**个人未认证订阅号**：这类账号没有 `draft/add`、`freepublish/submit` 等接口权限，所以发布环节走 Playwright 操作公众号后台的真实页面，而不是调用 API。

> 本文档默认你已经了解并遵守微信公众号平台的相关规范。自动化操作后台存在因页面改版而失效的可能，请自行评估使用风险。

## 技术栈

| 层 | 选型 | 作用 |
| --- | --- | --- |
| 运行时 | Node.js >= 20（ESM） | 全流程脚本 |
| 内容解析 | `gray-matter` | 解析 Markdown 的 front-matter（标题/作者/摘要/封面/主题） |
| 渲染 | `markdown-it` | Markdown → HTML |
| 主题预处理 | `postcss` | 展开 CSS 变量，剥离伪元素、交互伪类、`@media` 等微信不支持的部分 |
| 样式内联 | `juice` | 把 CSS 内联成 `style` 属性（微信编辑器只认内联样式） |
| 浏览器自动化 | `playwright` | 登录态持久化、编辑器填稿、封面选择、发表 |

产物是**纯内联样式的 HTML 片段**：不含 `<style>`、`class`、伪元素、flex/grid、绝对定位，正文图片以 base64 内联后在粘贴时由微信自动转存到 `mmbiz.qpic.cn`。

## 目录结构

```
autosubmit-wechatarticle/
├─ content/<slug>/index.md     文章源文件（front-matter + 正文）
├─ content/<slug>/assets/      正文与封面用的本地图片
├─ themes/orange-heart.css     网页版主题（含 CSS 变量、伪元素等）
├─ themes/*.wechat.css         预处理后的微信版主题（构建时生成，已忽略）
├─ src/
│  ├─ cli.js                   命令行入口
│  ├─ build.js                 渲染管线
│  ├─ theme.js                 主题预处理
│  ├─ assets.js                本地图片 → base64
│  ├─ checker.js               微信兼容性检查（13 条硬规则）
│  ├─ browser.js               浏览器启动、登录态读写、token 解析
│  ├─ login.js                 扫码登录并保存登录态
│  ├─ probe.js                 抓取后台真实 DOM 结构（校准选择器用）
│  ├─ publish.js               填稿、选封面、保存草稿、发表
│  └─ server.js                本地 Web UI 服务（无额外依赖）
├─ public/                     Web UI（index.html / styles.css / app.js）
├─ auth.json                   登录态凭证（本地生成，已忽略）
└─ build/<slug>/               渲染产物与调试截图（已忽略）
```

## 使用方法

### 1. 安装

```bash
npm install
npx playwright install chromium
```

`playwright` 会优先使用本机已安装的 Chrome，没有时回退到 Chromium。

### 2. 写文章

新建 `content/<slug>/index.md`，图片放在同级 `assets/` 目录：

```markdown
---
title: 文章标题
author: 作者名
digest: 摘要，转发卡片和会话里展示
cover: assets/cover.png
theme: orange-heart
tags: [公众号, 自动化]
---

正文……
```

front-matter 字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | 是 | 文章标题 |
| `author` | 否 | 作者（后台「作者」字段） |
| `digest` | 否 | 摘要，不填则自动截取正文开头 |
| `cover` | 否 | 封面图相对路径；发布时优先从正文图片里选封面 |
| `theme` | 否 | 主题名，默认 `orange-heart` |
| `tags` | 否 | 仅写入 `meta.json`，不上传后台 |

### 3. 本地渲染

```bash
node src/cli.js list                 # 列出 content/ 下的文章
node src/cli.js theme                # 重新生成微信版主题（改主题 CSS 后执行）
node src/cli.js build <slug>         # 渲染单篇
node src/cli.js build --all          # 渲染全部
```

产物在 `build/<slug>/`：

- `article.html`：内联样式正文片段
- `preview.html`：带「复制正文」按钮的预览页，可直接用浏览器打开
- `meta.json`：标题 / 作者 / 摘要 / 封面，供发布环节使用

渲染时会做兼容性检查，发现问题直接报错或告警（如外链图片、`class` 残留、超过 2MB 的图片）。

### 4. 登录公众号后台

```bash
node src/cli.js login
```

浏览器会打开后台登录页，用微信扫码。登录成功后登录态保存到 `auth.json`，并顺带抓取一次编辑器结构（`build/debug/editor-report.json`），用于校准选择器。

登录态会过期，遇到操作报错时重新执行一次 `login` 即可。

### 5. 保存草稿 / 发表

```bash
node src/cli.js draft <slug>            # 填稿 + 选封面 + 保存为草稿
node src/cli.js publish <slug>          # 走到「发表」弹窗即取消，用于检查
node src/cli.js publish <slug> --yes    # 真正发表
```

发布环节的处理顺序：

1. 打开「新建图文」编辑器，填标题、作者、摘要
2. 用剪贴板写入 `text/html` 后 `Ctrl+V` 粘贴正文，等待图片自动上传到微信
3. 打开封面选择器，从正文图片里选封面并确认裁剪
4. 保存为草稿
5. 点「发表」：首次可能先弹**创作来源声明**，脚本按「无需声明并发表」处理
6. 在「发表」弹窗里**关闭「群发通知」**（只发表，不群发粉丝）
7. 「未开启群发通知」二次确认，点「继续发表」
8. 如果弹出**微信验证二维码**，脚本会等待你用微信扫码（最多 5 分钟），通过后继续
9. 提交成功后后台跳回首页，命令输出「发表：成功」

所有步骤都会在 `build/debug/` 留下截图，便于排查。

### 常用参数

| 参数 | 说明 |
| --- | --- |
| `--headless` | 无头模式运行（`draft` / `publish`）；首次登录或需要扫码时建议不用 |
| `--all` | `build` 时渲染 `content/` 下全部文章 |
| `--yes` | `publish` 时真正提交；不加只打开弹窗再取消 |

## 图形界面（Web UI）

不想敲命令时，用本地 Web UI 完成同样的流程：

```bash
npm run ui          # 等价于 node src/server.js
```

打开 http://127.0.0.1:4173 （端口可用 `PORT` 环境变量改）。界面分三栏：

- **左：稿件列表**，点「新建」填一个 slug 即可建稿
- **中：字段 + 正文**，标题/作者/摘要/主题直接在界面里改，正文支持 Markdown 编辑、导入 `.md`、拖拽或粘贴图片（自动存入 `assets/` 并插入引用）
- **右：预览与终端**，构建产物直接内嵌预览，任务日志实时滚动

右上角四个按钮对应：`扫码登录`、`构建预览`、`存草稿`、`发表`。首次打开若缺少依赖，会弹窗提示并一键执行 `npm install` + `npx playwright install chromium`。

界面里填的字段保存在 `content/<slug>/article.json`，不需要写进 Markdown 的 front-matter；构建时以 `article.json` 为准，其次才是 front-matter。

## 隐私与安全

- `auth.json` 是完整的登录态凭证（cookie / localStorage），等价于账号密码。已在 `.gitignore` 中忽略，**不要提交、不要分享**。
- `build/` 包含正文内容、调试截图与后台 URL（含一次性 `token`），同样已忽略。
- 仓库不包含任何账号信息、token 或本地绝对路径；`src/` 里只有公众号域名、默认主题名等结构性常量。

## 已知限制

- 微信后台改版会导致选择器失效，需要重新执行 `probe` / `probe-cover` 抓取结构后更新 `src/publish.js`。
- 每次执行 `draft` / `publish` 都会新建一份草稿，多次执行会在草稿箱累积。
- 未认证订阅号发表后处于「审核中」，通过后才会公开。
- 群发通知默认被关闭；如需群发，需要自行调整发布步骤。

## License

[MIT](./LICENSE)
