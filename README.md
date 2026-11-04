# autosubmit

把本地 Markdown 文章渲染成各平台可用的格式，并通过浏览器自动化发布到微信公众号、CSDN、稀土掘金、知乎、博客园和 TRAE 官方中文社区。

面向个人未认证订阅号：这类账号没有草稿和发布接口权限，所以发布环节用 Playwright 操作平台后台的真实页面，而不是调用 API。自动化依赖平台页面结构，平台改版后可能需要调整选择器。

## 使用方法

1. 安装 Node.js 20 或更高版本，然后安装依赖和浏览器：

```bash
npm install
npx playwright install chromium
```

2. 启动本地界面：

```bash
npm run ui
```

打开 http://127.0.0.1:4173 ，新建稿件、编写正文、登录平台，构建预览后即可发布。文章与配图保存在 `content/<slug>/`（`index.md` 与 `assets/`），不会提交到仓库。

3. 也可以使用命令行：

```bash
node src/cli.js list                                # 列出文章
node src/cli.js build <slug> --platform juejin      # 构建预览（按平台上限自动压缩超限图片）
node src/cli.js login <platform>                    # 登录并保存登录态
node src/cli.js publish <slug> --platform <id>      # 发布（必须先构建）
```

首次使用前需要先登录对应平台，登录态保存在 `auth/` 目录，不会提交到仓库。

## License

本项目使用 MIT 协议，详见 [LICENSE](./LICENSE)。
