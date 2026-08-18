---
name: web-access
description: '联网访问：CDP 驱动用户已登录 Chrome（登录后操作、动态页面、反爬站点、社交媒体、本地书签/历史检索）'
license: MIT
github: https://github.com/eze-is/web-access
version: 2.5.0
user-invocable: true
allowed-tools:
  - Bash
  - WebFetch
  - WebSearch
  - ComputerUse
  - Read
---

# Web Access — CDP 驱动已登录 Chrome

> 来源：eze-is/web-access (MIT)，Mipham Code 合并升级。核心能力 = CDP Proxy 直连用户日常 Chrome，天然携带登录态。

## 前置检查

先确保 CDP 就绪：

```bash
node ~/.mipham/skills/web-access/scripts/check-deps.mjs
```

> Mipham Code 环境：`node` 不可用时可用 `bun` 替代（Bun 原生支持 WebSocket 与 node: 内建）。未通过时引导用户：Chrome 地址栏打开 `chrome://inspect/#remote-debugging`，勾选 "Allow remote debugging for this browser instance"。

**必须向用户展示**：部分站点对浏览器自动化检测严格，存在账号封禁风险。已内置防护但无法完全避免，Agent 继续操作即视为接受。

## 工具选择

| 场景                                          | 工具        |
| --------------------------------------------- | ----------- |
| 搜索摘要 / 发现来源                           | WebSearch   |
| URL 已知，定向提取                            | WebFetch    |
| URL 已知，要原始 HTML（meta/JSON-LD）         | Bash + curl |
| 非公开内容 / 反爬站点（小红书、微信公众号等） | 浏览器 CDP  |
| 需要登录态、交互、自由导航                    | 浏览器 CDP  |

浏览器 CDP 不要求 URL 已知；WebSearch/WebFetch/curl 均不处理登录态。

## 浏览器 CDP 模式

通过 CDP Proxy 直连用户日常 Chrome，天然携带登录态。**不主动操作用户已有 tab**，所有操作在自己创建的后台 tab 中进行，任务结束关闭自建 tab（保留用户原 tab）。

Proxy（`scripts/cdp-proxy.mjs`）由 `check-deps.mjs` 自动拉起并常驻。Proxy API（curl 调 `http://localhost:3456/...`）：

| 端点                                       | 用途                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `GET /targets`                             | 列出已开 tab                                                             |
| `GET /new?url=`                            | 新建后台 tab（自动等加载）                                               |
| `GET /navigate?target=&url=`               | 导航（自动等加载）                                                       |
| `GET /back?target=`                        | 后退                                                                     |
| `GET /info?target=`                        | 页面标题/URL/状态                                                        |
| `POST /eval?target=`（body=JS）            | 执行任意 JS（读写 DOM、提取、提交）                                      |
| `POST /click?target=`（body=CSS 选择器）   | JS 点击（`el.click()`，覆盖大多数场景）                                  |
| `POST /clickAt?target=`（body=CSS 选择器） | 真实鼠标点击（`Input.dispatchMouseEvent`，算用户手势，能触发文件对话框） |
| `POST /setFiles?target=`（body JSON）      | 设置 file input 本地文件路径（`DOM.setFileInputFiles`，绕过文件对话框）  |
| `GET /scroll?target=&y=&direction=`        | 滚动（`direction=down/up/top/bottom`，触发懒加载）                       |
| `GET /screenshot?target=&file=`            | 截图                                                                     |
| `GET /close?target=`                       | 关闭 tab                                                                 |

进入浏览器层后，`/eval` 是眼睛、`/click` 是手：先看 DOM 结构再决定下一步，不预先规划所有步骤。

### 登录判断

核心问题只有一个：**目标内容拿到了吗？** 打开页面先尝试获取目标内容；确认「目标内容无法获取」且判断登录能解决时，告知用户在其 Chrome 登录后继续（无需重启任何东西，刷新页面即可）。

### 媒体资源提取

判断内容在图片里时，用 `/eval` 从 DOM 直接拿图片 URL 定向读取，比全页截图精准。`/scroll` 到底部触发懒加载后再提取图片 URL。

### 视频内容获取

用户 Chrome 真实渲染，截图可捕获当前视频帧。用 `/eval` 操控 `<video>`（时长、seek、播放/暂停），配合 `/screenshot` 采帧，做离散采样分析。

## 本地 Chrome 资源

用户指向「本人访问过的页面」或「组织内部系统」时，检索本地书签/历史：

```bash
node ~/.mipham/skills/web-access/scripts/find-url.mjs [关键词...] [--only bookmarks|history] [--limit N] [--since 1d|7h|YYYY-MM-DD] [--sort recent|visits]
```

## 并行调研：子 Agent 分治

多个独立调研目标时，分治给子 Agent 并行执行（共享一个 Chrome、一个 Proxy，各自建 tab、各自 `/close`，无竞态）。子 Agent prompt 写**目标**（「获取/调研/了解」），不写**手段**（避免「搜索xx」锚定到 WebSearch 而错过需 CDP 的反爬站点）。

## 信息核实

核实目标是一手来源，非二手报道。搜索引擎是**定位**工具，不可直接**证明**真伪；找到来源后直接访问读原文。

| 信息类型      | 一手来源       |
| ------------- | -------------- |
| 政策/法规     | 发布机构官网   |
| 企业公告      | 公司官方新闻页 |
| 工具能力/用法 | 官方文档、源码 |

## 站点经验

特定网站经验按域名存 `~/.mipham/skills/web-access/references/site-patterns/<domain>.md`（frontmatter: domain/aliases/updated + 平台特征/有效模式/已知陷阱）。操作前若有匹配经验先读；操作成功后把验证过的新模式写回。

## Security Rules

- 不主动操作用户已有 tab；任务结束关闭自建 tab。
- 不提交凭据（除非用户显式批准）。
- 尊重 robots.txt 与速率限制；不抓 PII。
- proxy 仅绑 127.0.0.1，不暴露外网。
- 所有 URL 过 SSRF 校验后才 fetch。

## 何时不用本 skill

- 纯逻辑/算法题（推理非研究）。
- 代码已在上下文里的问题。
- 大文件下载 → Bash + curl。
