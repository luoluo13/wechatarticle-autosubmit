# autosubmit-wechatarticle

把本地 Markdown 渲染成图文，并通过浏览器自动化一键发布到微信公众号等多个平台。

面向**个人未认证订阅号**：这类账号没有 `draft/add`、`freepublish/submit` 等接口权限，所以发布环节走 Playwright 操作各平台后台的真实页面，而不是调用 API。

当前支持：微信公众号、CSDN、稀土掘金、知乎、博客园、TRAE 官方中文社区。

> 自动化操作后台存在因页面改版而失效的可能，请自行评估使用风险，并遵守各平台的内容规范。

## 技术栈

| 层 | 选型 | 作用 |
| --- | --- | --- |
| 运行时 | Node.js >= 20（ESM） | 全流程脚本 |
| 内容解析 | `gray-matter` | 解析 Markdown 的 front-matter（标题/作者/摘要/封面/主题） |
| 渲染 | `markdown-it` | Markdown → HTML |
| 主题预处理 | `postcss` | 展开 CSS 变量，剥离伪元素、交互伪类、`@media` 等微信不支持的部分 |
| 样式内联 | `juice` | 把 CSS 内联成 `style` 属性（微信编辑器只认内联样式） |
| 浏览器自动化 | `playwright` | 登录态持久化、编辑器填稿、图片上传、发布 |

公众号产物是**纯内联样式的 HTML 片段**：不含 `<style>`、`class`、伪元素、flex/grid、绝对定位，正文图片以 base64 内联后在粘贴时由微信自动转存到 `mmbiz.qpic.cn`。

其他平台按各自编辑器类型处理：Markdown 平台直接写入 Markdown，富文本平台粘贴 HTML；正文图片逐张上传到平台自己的图床后再回填 CDN 地址，不使用外链或 base64 直发。

## 目录结构

```
autosubmit-wechatarticle/
├─ content/<slug>/index.md     文章源文件（front-matter + 正文，本地目录，不入库）
├─ content/<slug>/assets/      正文与封面用的本地图片
├─ themes/orange-heart.css     网页版主题（含 CSS 变量、伪元素等）
├─ themes/*.wechat.css         预处理后的微信版主题（构建时生成，已忽略）
├─ src/
│  ├─ cli.js                   命令行入口
│  ├─ build.js                 渲染管线
│  ├─ theme.js                 主题预处理
│  ├─ assets.js                本地图片 → base64
│  ├─ checker.js               微信兼容性检查（13 条硬规则）
│  ├─ browser.js               浏览器启动、登录态读写、调试截图
│  ├─ server.js                本地 Web UI 服务（无额外依赖）
│  └─ platforms/
│     ├─ index.js              平台注册表
│     ├─ login.js              通用登录（打开登录页，轮询到登录后落盘）
│     ├─ shared.js             读取文章、标签归一化、图片地址替换
│     ├─ probe.js              抓取平台页面结构（校准选择器用）
│     ├─ wechat/               公众号专用：编辑器、封面、发表
│     └─ csdn.js / juejin.js / zhihu.js / cnblogs.js / trae.js
├─ public/                     Web UI（index.html / styles.css / app.js）
├─ auth/<platform>.json        各平台登录态（本地生成，已忽略）
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

`content/` 是本地文章目录，不随仓库分发，也已在 `.gitignore` 中忽略。`npm run ui` 首次启动会自动创建这个空目录，你也可以在界面里直接「新建」一篇文章。

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
| `author` | 否 | 作者（公众号后台「作者」字段） |
| `digest` | 否 | 摘要，不填则自动截取正文开头 |
| `cover` | 否 | 封面图相对路径，缺省回退到 `assets/cover.png` |
| `theme` | 否 | 主题名，默认 `orange-heart` |
| `tags` | 否 | 标签 / 话题，供各平台发布时使用 |

### 3. 本地渲染

```bash
node src/cli.js list                 # 列出 content/ 下的文章
node src/cli.js theme                # 重新生成微信版主题（改主题 CSS 后执行）
node src/cli.js build <slug>         # 渲染单篇
node src/cli.js build --all          # 渲染全部
```

产物在 `build/<slug>/`：

- `article.html`：内联样式正文片段
- `preview.html`：带「复制正文」按钮的预览页
- `meta.json`：标题 / 作者 / 摘要 / 封面

### 4. 登录平台

```bash
node src/cli.js login wechat         # 微信公众号（微信扫码）
node src/cli.js login csdn           # 其他平台同理：csdn / juejin / zhihu / cnblogs / trae
node src/cli.js login --all          # 一次打开全部登录页，逐个登录
```

登录成功后登录态保存到 `auth/<platform>.json`。登录态会过期，遇到「登录态已失效」提示时重新执行一次 `login` 即可。

### 5. 发布

```bash
node src/cli.js publish <slug> --platform wechat --yes   # 公众号：真正发表
node src/cli.js publish <slug> --platform csdn           # 其他平台默认直接发布
node src/cli.js publish <slug> --platform juejin --dry   # 只填好表单不提交，用于检查
node src/cli.js publish <slug> --platform trae --category 技巧分享 --tags "Linux,Arch"
```

各平台要求：

| 平台 | 正文形式 | 分类 / 板块 | 标签 / 话题 | 备注 |
| --- | --- | --- | --- | --- |
| 微信公众号 | 内联样式 HTML 粘贴 | — | 不使用 | 默认关闭群发通知；封面默认取正文第一张，发布弹窗里可改选或上传；首次可能需扫码验证 |
| CSDN | Markdown | 不需要 | 必填 1~5 个 | 摘要取 `digest`；自动上传封面 |
| 稀土掘金 | Markdown | 必选 | 必填，只能用站内已有标签（平台不允许新建） | 摘要不足 50 字会用正文补齐；标签数量上限由账号决定，超出部分自动忽略；自动上传封面 |
| 知乎 | 富文本粘贴 HTML | 不需要 | 必填话题 1~3 个，只能从搜索结果里选 | 图片逐张粘贴上传，发布后自动转永久地址 |
| 博客园 | Markdown | 可选，取站点分类 | 可选，回车即新建 | 可直接粘贴图片上传 |
| TRAE 社区 | Markdown | 必选板块 | 可选，部分板块不开放 | 图片走社区上传接口写入 CDN |

中文分类/板块名建议直接用后台显示的名字，脚本按名字精确匹配；匹配不到会中断并提示可选值。

Web UI 的发布弹窗还会：

- 打开掘金时先拉取站内热门标签，输入关键词时实时搜索站内标签，点候选直接加入（掘金不允许新建标签）；
- 支持自选封面：列出文章 `assets/` 下的图片（公众号只列正文引用过的），也可「导入图片」上传新图作为封面；
- 掘金分类/标签没能自动填好时，仍会填完摘要、封面等其它内容，并保留浏览器窗口，等用户手动补完后点「确定并发布」。

### 常用参数

| 参数 | 说明 |
| --- | --- |
| `--platform <id>` | 目标平台，默认 `wechat` |
| `--dry` | 只填写表单不提交（公众号以外的平台） |
| `--yes` | 公众号真正提交发表；不加只走到发表弹窗 |
| `--category <name>` | 分类 / 板块名 |
| `--tags "a,b"` | 标签 / 话题，逗号分隔 |
| `--headless` | 无头模式运行；首次登录或需要扫码时不要用 |

## 图形界面（Web UI）

不想敲命令时，用本地 Web UI 完成同样的流程：

```bash
npm run ui          # 等价于 node src/server.js
```

打开 http://127.0.0.1:4173 （端口可用 `PORT` 环境变量改）。界面分三栏：

- **左：稿件列表**，点「新建」填一个 slug 即可建稿，悬停稿件右侧的「×」可直接删除（连同 `assets/` 与构建产物，需确认一次）
- **中：字段 + 正文**，标题/作者/摘要/主题直接在界面里改，正文支持 Markdown 编辑、导入 `.md`、拖拽或粘贴图片（自动存入 `assets/` 并插入引用）
- **右：预览与终端**，构建产物直接内嵌预览，任务日志实时滚动

顶部的平台区按「网格选平台 + 单行操作栏」展示：每个平台是一个带登录状态圆点的小方块，点选后下方显示当前平台，并给出登录/后台、存草稿（仅公众号）、发布；平台多了可以用「筛选平台…」快速定位，不再挤在一行里。点「发布」会弹出分类/标签选择框，分类选项实时从平台读取，选完直接发布。

界面里填的字段保存在 `content/<slug>/article.json`，不需要写进 Markdown 的 front-matter；构建时以 `article.json` 为准，其次才是 front-matter。

## 隐私与安全

- `auth/` 下是各平台完整的登录态凭证（cookie / localStorage），等价于账号密码。已在 `.gitignore` 中忽略，**不要提交、不要分享**。
- `build/` 包含正文内容、调试截图与后台 URL（含一次性 `token`），同样已忽略。
- `content/` 保存你的文章与配图，属于个人内容，已忽略，不会出现在仓库里。
- 仓库不包含任何账号信息、token 或本地绝对路径。

## 已知限制

- 平台改版会导致选择器失效，需要重新执行 `probe` 抓取结构后更新对应的 `src/platforms/*.js`。
- 知乎话题、掘金标签必须是站内已有的词。掘金不支持新建标签，标签上限还因账号而异（有的账号只能选 1 个），脚本会先查站内标签再按上限添加。
- 掘金的分类/标签没法自动满足时（比如标签站内不存在），脚本不会关页面，会把浏览器留给你手动选好后点「确定并发布」。
- 博客园使用站点分类；TRAE 部分板块不开放标签，脚本会自动跳过标签。
- 每次执行都会新建一篇内容，多次执行会在平台后台产生多篇稿件。
- 未认证订阅号发表后处于「审核中」，通过后才会公开；群发通知默认被关闭。

## License

[MIT](./LICENSE)
