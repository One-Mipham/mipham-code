# Mipham Code Telegram Bot 远程控制

> **版本**: 1.0.0
> **日期**: 2026-08-20
> **状态**: 设计完成，待实现
> **参考**: 飞书 Bot 远程控制（`2026-08-18-feishu-bot-remote-control-design.md`）+ OpenClaw 轴辐式网关范式（Peter Steinberger，MIT）
> **路线图**: 实现计划见 `docs/superpowers/plans/2026-08-20-telegram-remote-control.md`（writing-plans 阶段产出）

---

## 一、目标

在 Mipham Code 现有 **Daemon 后台持久化架构 + 飞书远程控制** 之上，新增 **Telegram 远程控制**：用户通过 Telegram Bot 发消息，daemon 在后台跑会话并把结果回传。

- 每个 Telegram chat 映射到一个**持久会话**（多轮对话，Bot 记得上下文）
- 复用 daemon 已有的 SessionManager / WorkerPool / RateLimiter / 引擎
- **长轮询**（`getUpdates`）：daemon 主动 poll，无需公网入口，本地开发机或服务器都能跑
- 安全优先：chat 白名单 + 最小权限 + 限流

**背景（why 这个方向）**：Mipham Code 的 daemon 已经是一个 **OpenClaw 式的轴辐式网关轴心**——`Bun.serve` + `SessionManager` + worker pool 对应 OpenClaw 的 Gateway（消息路由/会话/流），`feishu/adapter.ts`（及本设计的 `telegram/`）对应 channel adapter。飞书是本网关的第一个辐条（参考 ZCode 的「Bot 控制」），Telegram 是第二个。区别只在「轴心里装的是什么」：OpenClaw 是通用个人助理，Mipham Code 是 coding 终端 + CRSI。

**非目标（范围外）**：

- 不做微信 / 企业微信 / 钉钉（第 3 个频道时再抽 channel 抽象，见 §二「频道抽象」）
- 不做流式回传（MVP 一次性回传最终文本，对齐飞书）
- 不做 Telegram inline keyboard / 交互卡片（完整「steer」）
- 不做结果分片协议（单条超 4096 字符时截断）

---

## 二、设计决策

| 维度     | 选择                                                                            | 理由                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IM 平台  | Telegram Bot（`@BotFather` 创建，拿 `botToken`）                                | 官方 Bot API，长轮询免公网入口；与飞书 webhook（需公网）互补                                                                                                      |
| 接收方式 | **长轮询 `getUpdates`**                                                         | daemon 主动 poll，本地 NAT 后也能用；用户选定                                                                                                                     |
| 架构     | **daemon 内 `telegram/` 模块 + poller**，与 `feishu/` 平行                      | 复用 `engineCache`/`SessionManager`/`RateLimiter`，单进程单部署；模块边界保证后续可拆独立 gateway（strangler fig）                                                |
| 会话映射 | 泛化 `getOrCreateByFeishuOpenId` → `getOrCreateByExternalUser(channel, userId)` | 消除 Feishu 专属命名，Telegram 复用；对齐现有 **name-based 实现**（`${channel}-${userId}`），不动 db schema                                                       |
| SDK      | **裸 fetch（零依赖）**                                                          | Telegram Bot API 是简单 JSON HTTP（`https://api.telegram.org/bot<token>/<method>`）；契合零依赖传统；不引入 `node-telegram-bot-api`（老旧带坑）                   |
| 权限模式 | `default`（headless 最小权限）                                                  | daemon 会话无弹窗，ask 级工具（Bash/Write/Edit）默认拦，防注入越权；同飞书                                                                                        |
| 频道抽象 | **现在薄做，预留 seam**                                                         | rule of three：2 个频道不抽象；`FeishuAdapter`/`TelegramAdapter` 的 deps 形状已一致（`sm`/`getOrCreateWorker`/`rateLimiter`），第 3 频道时抽 channel 接口成本极低 |

> **部署注记**：飞书走 webhook，daemon 部署在腾讯云公网服务器（TLS/域名/PM2 现成）。Telegram 长轮询不依赖公网入口，同一 daemon 进程跑即可；也可独立跑在本地开发机（`botToken` + 白名单 env 即可）。

---

## 三、进程拓扑

```
┌──────────────────────────────────────────────────────────────┐
│               Telegram 用户（手机/桌面）                        │
│   发消息 → Telegram 服务器（Bot API）                            │
└──────────────────────────────────────────────────────────────┘
                              ▲  daemon 主动长轮询 getUpdates（HTTPS）
                              │
┌─────────────────────────────┼────────────────────────────────┐
│              Daemon 进程（本地 或 腾讯云，PM2 常驻）              │
│                             │                                  │
│   ┌─────────────────────────┴──────────────────┐              │
│   │  telegram/poller.ts（getUpdates 循环 + offset + 退避）  │              │
│   │     │                                       │              │
│   │     ▼                                       │              │
│   │  telegram/adapter.ts（白名单 → session 映射 → 编排）  │              │
│   │  telegram/api.ts（裸 fetch：getUpdates / sendText）  │              │
│   └──────┬─────────────────────────────────────┘              │
│          │ 复用（in-process，无 HTTP 往返）                      │
│   ┌──────▼─────────────────────────────────────┐              │
│   │  SessionManager + WorkerPool + engineCache   │              │
│   │  RateLimiter + SQLite（sessions/messages/…） │              │
│   └──────────────────────────────────────────────┘             │
└──────────────────────────────────────────────────────────────┘
```

---

## 四、组件

### 4.1 `src/daemon/telegram/types.ts` — 类型

```ts
export interface TelegramConfig {
  botToken: string
  allowedChatIds: string[] // 白名单（Telegram chat id，字符串化便于比对）
}
export interface TelegramMessage {
  chatId: string
  messageId: number
  text: string
}
```

### 4.2 `src/daemon/telegram/env.ts` — 环境解析（fail-closed）

- `parseTelegramEnv(): TelegramConfig | null`
- 必填 `TELEGRAM_BOT_TOKEN`；缺失 → 返回 `null`（daemon 不启用 Telegram，同飞书 fail-closed）
- 白名单 `TELEGRAM_ALLOWED_CHAT_IDS`（逗号分隔，trim 后过滤空项）

### 4.3 `src/daemon/telegram/api.ts` — Telegram API（裸 fetch）

```ts
export interface TelegramApi {
  getUpdates(offset: number, timeoutSeconds: number): Promise<unknown[]>
  sendText(chatId: string, text: string): Promise<void>
}
```

- `getUpdates`：`GET /bot<token>/getUpdates?offset=&timeout=&limit=100&allowed_updates=["message"]`
- `sendText`：`POST /bot<token>/sendMessage`（JSON body：`chat_id` + `text`，4096 上限）
- 用 `fetch` 直连 `https://api.telegram.org`，不引第三方 SDK

### 4.4 `src/daemon/telegram/poller.ts` — 长轮询循环

- `startTelegramPoller(api, onMessage): () => void`，返回 stop 函数（unref 定时器不阻退出）
- 循环：`getUpdates(offset, 30)` → 逐条 `update.message.text` 存在则 `onMessage({chatId, messageId, text})` → `offset = last_update_id + 1`
- **错误退避**：网络失败指数退避（1s→2s→…→封顶 30s），失败只记日志、不崩进程
- 纯函数部分（offset 推进 / 更新解析）抽出来便于单测
- **chat id 精度**：Telegram `chat.id` 是 64 位，可能超 JS 安全整数（2^53）。个人 bot 的 owner id 通常 < 2^53 无碍；统一 `String(chat.id)` 字符串化比对。频道/群超大 id 如需支持，后续再引入 bigint 解析（当前按 number 字符串化，记入范围外）

### 4.5 `src/daemon/telegram/adapter.ts` — 业务编排（镜像飞书）

- `createTelegramAdapter(config, deps)` → `{ start(): () => void, isAllowed(chatId): boolean }`
- `deps` 形状与飞书一致：`{ sm, getOrCreateWorker, rateLimiter, cwd, provider, model }`
- `onMessage` 流程：白名单 → 限流 → 会话 → `processPrompt` → 回发（见 §五）

### 4.6 `session-manager.ts` — 会话映射泛化

```ts
getOrCreateByExternalUser(
  channel: string,          // 'feishu' | 'telegram'
  userId: string,
  cwd: string, provider: string, model: string,
): DaemonSession {
  const name = `${channel}-${userId}`
  const existing = this.db.listSessions().find((s) => s.name === name && s.status !== 'closed')
  if (existing) return existing
  return this.db.createSession({ name, cwd, provider, model })
}
```

- 删除 `getOrCreateByFeishuOpenId`，飞书 adapter 调用点改为 `('feishu', msg.openId, ...)`
- 对齐现有 name-based 实现（飞书 spec 原拟 `feishuOpenId` 列，实装走 name，本设计跟随实装）

### 4.7 `server.ts` + `index.ts` 挂载

- `ServerConfig` 加 `telegram?: { config: TelegramConfig; cwd; provider; model }`（对齐 `feishu?`）
- `createServer` 内 `createTelegramAdapter(...).start()`（长轮询无 webhook 路由，start 即拉起 poller）
- 心跳：`startHeartbeat` 的 `push` 并列加 Telegram 推送（推给 `allowedChatIds`），复用纯函数
- daemon 入口 `index.ts` 解析 `parseTelegramEnv()`，非空才注入 `telegram` 配置

---

## 五、数据流

```
1. Telegram 用户发消息
   ↓
2. poller getUpdates 拉回 update（长轮询 timeout=30s）
   ↓
3. 解析 update.message → { chatId, messageId, text }
   ↓
4. 白名单鉴权：chatId 不在 TELEGRAM_ALLOWED_CHAT_IDS → 静默丢弃
   ↓
5. 限流：rateLimiter.check('telegram:' + chatId)
   ↓
6. chatId → session（getOrCreateByExternalUser('telegram', chatId)）
   ↓
7. worker.processPrompt(text)（in-process await，不走 HTTP prompt 端点，避开 fire-and-forget 拿不到结果）
   ↓
8. 取 worker.getLastAssistantContent() 作为最终回复（截断 4096）
   ↓
9. api.sendText(chatId, result)
```

---

## 六、安全模型

| 威胁                      | 防御                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 未授权用户指挥            | `TELEGRAM_ALLOWED_CHAT_IDS` 白名单（chat id 整数，仅 Bot 所有者/授权成员）                                                      |
| Prompt injection 越权执行 | daemon 会话 `default` 权限（headless 无弹窗，ask 级 Bash/Write/Edit 拦）+ 白名单；上线前过 CLAUDE.md 红队 prompt-injection 测试 |
| 洪水 / 滥用               | 复用 `RateLimiter`（按 chatId 为 key，独立限额）                                                                                |
| 有害/敏感输出             | 响应内容过滤（NSFW / PII），对齐 CLAUDE.md AI 安全                                                                              |
| 密钥泄漏                  | `TELEGRAM_BOT_TOKEN` 全 env 注入，禁止硬编码/日志                                                                               |
| 更新重复投递              | `offset = update_id + 1` 幂等推进，重复 update_id 不重复处理                                                                    |

**依赖合规**：裸 `fetch`，零新增依赖，无 copyleft/GPL 风险。

---

## 七、错误处理

| 场景                 | 处理                                        |
| -------------------- | ------------------------------------------- |
| getUpdates 网络失败  | 指数退避重试（1s→…→30s 封顶），不崩进程     |
| chatId 未授权        | 静默丢弃（不回传，避免探测白名单）          |
| 引擎初始化失败       | 回传「会话初始化失败」友好文案              |
| 会话关闭/异常        | 回传错误摘要（截断，不泄漏内部堆栈）        |
| sendText 失败 / 超限 | 记日志，不 rethrow（避免 poller 崩溃）      |
| poller 重复启动      | `start` 幂等（已启动则复用，返回同一 stop） |

---

## 八、测试策略

| 层                     | 内容                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------- |
| 单测 `env`             | fail-closed（缺 botToken → null）、白名单拆分/trim/过滤                            |
| 单测 `api`             | getUpdates / sendText 的 URL + body 构造（mock fetch，不真调 Telegram）            |
| 单测 `poller`          | offset 推进（update_id+1）、文本解析、错误退避（mock api）                         |
| 单测 `adapter`         | 白名单判定、限流、chatId→session 映射、未授权丢弃（mock deps）                     |
| 单测 `session-manager` | `getOrCreateByExternalUser`：新建 / 复用 / closed 重建（`feishu-`/`telegram-` 名） |
| 集成                   | mock Telegram update → adapter 跑 prompt → 回传（用测试 provider 不真调 LLM）      |
| 红队                   | 上线前 prompt-injection 对抗测试（CLAUDE.md 强制）                                 |

---

## 九、范围外（后续）

- 微信 / 企业微信 / 钉钉适配（第 3 个频道时抽 channel 接口）
- Telegram inline keyboard / 交互卡片（完整「steer」）
- 结果流式回传（MVP 一次性回传）
- 多 Bot / 多租户
- 长消息分片协议（>4096 当前直接截断）
