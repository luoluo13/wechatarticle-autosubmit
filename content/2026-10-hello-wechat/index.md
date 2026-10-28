---
title: 用一条本地管线，把 Markdown 变成公众号图文
author: 你的名字
digest: 从 Markdown 到可直接粘贴进公众号后台的图文，只需要一条命令。
cover: assets/cover.png
theme: orange-heart
tags: [公众号, 自动化, Markdown]
---

> 这是一篇由本框架渲染出来的示例文章，用来验证排版、图片内联和兼容性检查是否正常。

## 为什么不用外链图床

微信正文里的外链图片在**读者手机上是打不开的**，这是最常见的翻车点。本框架在构建阶段就把本地图片转成 base64 内联，粘贴进编辑器时由微信自动转存。

![示例配图](assets/inline-demo.png)

## 支持的排版元素

### 有序与无序列表

1. 第一项，带 **加粗** 和 `行内代码`
2. 第二项
3. 第三项

- 无序列表项
- 另一项
  - 嵌套的一层

### 引用块

> 引用块使用主题色做左侧竖线。mdnice 里那些装饰性伪元素（比如开头的引号）会在预处理阶段被剥离，因为微信内联样式表达不了伪元素。

### 表格

| 环节 | 命令 | 产物 |
| --- | --- | --- |
| 渲染 | `build` | article.html |
| 登录 | `login` | auth.json |
| 发布 | `draft` | 草稿箱 |

### 代码块

```js
const html = juice.inlineContent(section, css, { applyStyleTags: false });
```

---

正文结束。打开 `build/2026-10-hello-wechat/preview.html` 点「复制正文」，再到公众号后台粘贴即可。
