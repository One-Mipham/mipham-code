# Mipham Code 企业微信 Bot 远程控制

> **版本**: 1.0.0
> **日期**: 2026-08-21
> **状态**: 设计完成，待实现
> **参考**: 飞书（`2026-08-18-feishu-bot-remote-control-design.md`）+ Telegram（`2026-08-20-telegram-remote-control-design.md`）+ 企业微信智能机器人长连接官方文档（`path/101463`）+ cc-connect 接入指南
> **路线图**: 实现计划待 writing-plans 阶段产出

---

## 一、目标

在 Mipham Code 现有 **Daemon 后台持久化架构 + 飞书 / Telegram 远程控制** 之上，新增 **企业微信远程控制**：用户通过企微「智能机器人」发消息，daemon 在后台跑会话并把结果回传。

- 每个企微 `userid` 映射到一个**持久会话**（多轮对话，Bot 记得上下文）
- 复用 daemon 已有的 SessionManager / WorkerPool / RateLimiter / 引擎
- **长连接 WebSocket**（`wss://openws.work.weixin.qq.com`）：daemon 主动连，无需公网入口，本地开发机或服务器都能跑
- 安全优先：`userid` 白名单 + 最小权限 + 限流

**背景（why 这个方向）**：Mipham Code 的 daemon 已经是一个 **OpenClaw 式的轴辐式网关轴心**。飞书（webhook 回调）是第一个辐条，Telegram（长轮询）是第二个，**企业微信是第三个**——触发 `rule of three`，需评估频道抽象（见 §二）。与飞书的本质区别：飞书「自定义机器人」只推不收，故飞书走「自建应用」+ 事件订阅；企微有 **「智能机器人 API 模式」** 这个本身就能收消息的新形态，无需自建应用、无需 XML AES 加解密，比飞书轻一个数量级。

**非目标（范围外）**：

- 不做钉钉（第 4 个频道时才抽完整 channel 接口）
- 不做流式回传（MVP 一次性回传最终文本，对齐飞书/Telegram）
- 不做群聊（企微已知 bug，见 §六）
- 不做图片 / 文件收发（MVP 只文字）
- 不做交互卡片 / 完整「steer」

---

## 二、设计决策

| 维度     | 选择                                                                   | 理由                                                                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| IM 平台  | 企业微信 **智能机器人 API 模式**                                       | 智能机器人本身能收消息（长连接/回调），免去自建应用（corpId/agentId/Secret + XML AES + 可信 IP）的重活；区别于传统「群自定义机器人」（只推不收，收不到消息）                                                             |
| 接收方式 | **长连接 WebSocket**（`aibot_subscribe` 订阅）                         | 无需公网 URL、无需 IP 白名单、无需 Token+EncodingAESKey 加解密；主动连，本地 NAT 后也能跑；对标 Telegram 长轮询的「无公网」体验，但用服务端推送替代轮询                                                                  |
| 凭证     | **Bot ID + Secret**（建连后 `aibot_subscribe` 携带）                   | 仅两个字符串，比飞书（appId/secret/encryptKey/verificationToken）更简；Secret 创建时只显示一次，丢失需重建机器人                                                                                                         |
| 架构     | **daemon 内 `wecom/` 模块 + ws-client**，与 `feishu/` `telegram/` 平行 | 复用 `engineCache`/`SessionManager`/`RateLimiter`，单进程单部署；模块边界保证后续可拆独立 gateway（strangler fig）                                                                                                       |
| SDK/传输 | **`globalThis.WebSocket`（Bun + Node 22+ 原生）+ 裸 fetch**            | 零依赖（daemon 跑 Bun，Node 22+ 亦有原生 WebSocket）；契合 telegram「裸 fetch」零依赖传统；不引 `ws` 库                                                                                                                  |
| 会话映射 | `getOrCreateByExternalUser('wecom', userid, …)`                        | 已在 Telegram 落地时泛化（`${channel}-${userId}` name-based），本次**零改动**                                                                                                                                            |
| 权限模式 | `default`（headless 最小权限）                                         | daemon 会话无弹窗，ask 级工具（Bash/Write/Edit）默认拦，防注入越权；同飞书/Telegram                                                                                                                                      |
| 频道抽象 | **抽共享 message-handler 骨架**（rule of three 触发）                  | 三频道 `onMessage` 骨架逐行一致（白名单→限流→会话→`processPrompt`→回发，仅 channel 名/字段/截断长度不同）；只抽这一小块，**不抽完整 ChannelAdapter 接口**（入口差异大：webhook / 长轮询 / WebSocket 三种，强抽反而扭曲） |

> **部署注记**：飞书走 webhook 需公网；Telegram 长轮询与企微长连接均**不依赖公网入口**，同一 daemon 进程跑即可，也可独立跑在本地开发机（`botId` + `secret` + 白名单 env 即可）。企微长连接约束「同一机器人仅 1 个长连接」→ daemon 必须**单实例**部署（与现有 PM2 单实例一致）。

---

## 三、进程拓扑

```
┌──────────────────────────────────────────────────────────────┐
│              企业微信用户（手机/桌面，单聊机器人）               │
│   发消息 → 企微服务器 → 推送 aibot_msg_callback                 │
└──────────────────────────────────────────────────────────────┘
                              ▲  daemon 主动建连 wss://（长连接，推送）
                              │
┌─────────────────────────────┼────────────────────────────────┐
│              Daemon 进程（本地 或 腾讯云，PM2 常驻单实例）        │
│                             │                                  │
│   ┌─────────────────────────┴──────────────────┐              │
│   │  wecom/ws-client.ts（建连→aibot_subscribe→心跳→重连）│      │
│   │     │                                       │              │
│   │     ▼                                       │              │
│   │  wecom/adapter.ts（白名单→session 映射→编排）│              │
│   │  wecom/api.ts（WebSocket 收发：subscribe/respond）│        │
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

### 4.1 `src/daemon/wecom/types.ts` — 类型

```ts
export interface WecomConfig {
  botId: string
  botSecret: string
  allowedUserIds: string[] // 白名单（企微内部 userid）
}

export interface WecomMessage {
  userId: string // 发消息用户（userid）
  chatId: string // 会话 id（chatid）
  msgId: string // 消息 id（用于 req_id 关联回包）
  text: string // 文本内容
}
```

> 字段来源：官方文档 `aibot_msg_callback` body 含 `userid`/`msgtype`/`chat_type`/`chatid`/`content`。**完整 body 结构以官方文档为准，实现阶段逐字段核对**（本 spec 只锁定白名单/会话映射所需的 `userid` + 回包关联所需的消息标识）。

### 4.2 `src/daemon/wecom/env.ts` — 环境解析（fail-closed）

- `parseWecomEnv(): WecomConfig | null`
- 必填 `WECOM_BOT_ID` + `WECOM_BOT_SECRET`；任一缺失 → 返回 `null`（daemon 不启用企微，同飞书/Telegram fail-closed）
- 白名单 `WECOM_ALLOWED_USER_IDS`（逗号分隔，trim 后过滤空项）

### 4.3 `src/daemon/wecom/api.ts` — 企微长连接收发

```ts
export interface WecomApi {
  connect(onMessage: (msg: WecomMessage) => Promise<void>): () => void // 建连 + 订阅，返回 stop
  respond(userId: string, text: string): Promise<void> // aibot_respond_msg
}
```

- 建连 `wss://openws.work.weixin.qq.com`，用 `globalThis.WebSocket`
- 建连后立即发 `aibot_subscribe`（`bot_id` + `secret`）；订阅成功才进入就绪态
- 收到 `aibot_msg_callback` → 解析 `userid` + `content` → `onMessage`
- `respond`：发 `aibot_respond_msg`（`req_id` 关联回调、`stream.id` 关联流式；MVP 一次性非流式，`finish=true`）

### 4.4 `src/daemon/wecom/ws-client.ts` — 心跳 + 重连

- `startWecomWs(api, onMessage): () => void`，返回 stop 函数
- **心跳**：每 30s 发 `ping`（官方要求，超时未心跳服务端断开）
- **重连**：断开后指数退避（1s→2s→4s→…→封顶 30s），复用 telegram `poller.ts` 的 `nextBackoff` 思路
- **`disconnected_event` 互踢**：新连接建立时旧连接收到该事件并被服务端断开 → 客户端收到后主动 close、不再重连（避免新旧连接打架）
- 纯函数部分（退避推进 / 消息解析）抽出来便于单测

### 4.5 `src/daemon/wecom/adapter.ts` — 业务编排（镜像 Telegram）

- `createWecomAdapter(config, api, deps)` → `{ start(): () => void, isAllowed(userId): boolean }`
- `deps` 形状与飞书/Telegram 一致：`{ sm, getOrCreateWorker, rateLimiter, cwd, provider, model }`
- `onMessage` 流程：白名单 → 限流 → 会话 → `processPrompt` → 回发（见 §五）

### 4.6 频道抽象 — 共享 message-handler 骨架（rule of three）

- 抽 `src/daemon/channel-message.ts`（或 `channel/`）里的 `handleChannelMessage(opts)` 纯函数，覆盖三频道一致的骨架：
  `白名单.has(externalId) → rateLimiter.check('channel:' + externalId) → getOrCreateByExternalUser(channel, externalId, …) → getOrCreateWorker → processPrompt → getLastAssistantContent → sendText(截断)`
- `opts` 注入差异点：`channel` 名、`externalId`、`sendText`、`maxLen`（飞书 4000 / Telegram 4096 / 企微按文档）、错误文案
- 飞书/Telegram adapter 重构为调用该骨架（surgical：只替换 onMessage 体内重复段，不动各自入口 `handleEvent`/`start`）
- **不抽完整 `ChannelAdapter` 接口**：入口差异大（webhook / 长轮询 / WebSocket），第 4 频道（如钉钉）再评估

### 4.7 `server.ts` + `index.ts` 挂载

- `ServerConfig` 加 `wecom?: { config: WecomConfig; cwd; provider; model }`（对齐 `feishu?`/`telegram?`）
- `createServer` 内 `createWecomAdapter(...).start()`（长连接无 webhook 路由，`start` 即拉起 ws-client，同 telegram）
- 心跳：`startHeartbeat` 的 `push` 并列加企微推送（推给 `allowedUserIds`），复用纯函数
- daemon 入口 `index.ts` 解析 `parseWecomEnv()`，非空才注入 `wecom` 配置

---

## 五、数据流

```
1. 企微用户单聊机器人发消息
   ↓
2. 企微服务器经长连接推送 aibot_msg_callback（含 userid + content）
   ↓
3. ws-client 收到 → 解析 { userId, chatId, msgId, text }
   ↓
4. 白名单鉴权：userId 不在 WECOM_ALLOWED_USER_IDS → 静默丢弃
   ↓
5. 限流：rateLimiter.check('wecom:' + userId)
   ↓
6. userId → session（getOrCreateByExternalUser('wecom', userId)）
   ↓
7. worker.processPrompt(text)（in-process await，不走 HTTP prompt 端点，避开 fire-and-forget 拿不到结果）
   ↓
8. 取 worker.getLastAssistantContent() 作为最终回复（截断）
   ↓
9. api.respond(userId, result)  → aibot_respond_msg 经长连接回发
```

---

## 六、安全模型

| 威胁                      | 防御                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 未授权用户指挥            | `WECOM_ALLOWED_USER_IDS` 白名单（企微内部 `userid`，仅 Bot 所有者/授权成员）                                                                                       |
| Prompt injection 越权执行 | daemon 会话 `default` 权限（headless 无弹窗，ask 级 Bash/Write/Edit 拦）+ 白名单；上线前过 CLAUDE.md 红队 prompt-injection 测试                                    |
| 洪水 / 滥用               | 复用 `RateLimiter`（按 `userid` 为 key，独立限额）                                                                                                                 |
| 有害/敏感输出             | 响应内容过滤（NSFW / PII），对齐 CLAUDE.md AI 安全                                                                                                                 |
| 密钥泄漏                  | `WECOM_BOT_ID`/`WECOM_BOT_SECRET` 全 env 注入，禁止硬编码/日志；Secret 只显示一次，丢失即重建机器人                                                                |
| 消息重复投递              | 长连接推送为 at-least-once；用 `msgId` 幂等去重（进程内 Set，对齐 Telegram 的 offset 姿态；崩溃/重启窗口内可能重复执行，同 Feishu/Telegram 的 at-least-once 姿态） |

**平台硬限制（上线前必须确认，三条）**：

| #   | 限制                                       | 影响                                                          | 应对                                   |
| --- | ------------------------------------------ | ------------------------------------------------------------- | -------------------------------------- |
| 1   | **群聊普通成员消息无回调**（已知疑似 bug） | 群聊可能仅管理员 @机器人 才推送                               | 首版只保证单聊；群聊标注「待官方修复」 |
| 2   | **个人授权限制**                           | 机器人开了「个人授权（消息/文档权限）」后，非创建者不能发消息 | 建机器人时**不开**个人授权             |
| 3   | **>10 人企业消息能力受限**                 | wecom-cli 实测：>10 人只剩文档+待办，卡消息                   | 目标用户若是 ≤10 人企业才适用          |

**工程约束**：同一机器人仅 1 个长连接 → daemon 单实例；30 条/分钟、1000 条/小时频率限制。

**依赖合规**：`globalThis.WebSocket`（Bun/Node 原生）+ 裸 `fetch`，零新增依赖，无 copyleft/GPL 风险。

---

## 七、错误处理

| 场景                 | 处理                                        |
| -------------------- | ------------------------------------------- |
| 建连 / 订阅失败      | 指数退避重连（1s→…→30s 封顶），不崩进程     |
| 心跳超时被服务端断开 | 自动重连（同退避策略）                      |
| `disconnected_event` | 主动 close，不再重连（防新旧连接互踢）      |
| userId 未授权        | 静默丢弃（不回传，避免探测白名单）          |
| 引擎初始化失败       | 回传「会话初始化失败」友好文案              |
| 会话关闭/异常        | 回传错误摘要（截断，不泄漏内部堆栈）        |
| respond 失败 / 超限  | 记日志，不 rethrow（避免 ws 循环崩溃）      |
| ws-client 重复启动   | `start` 幂等（已启动则复用，返回同一 stop） |

---

## 八、测试策略

| 层                     | 内容                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------- |
| 单测 `env`             | fail-closed（缺 botId/secret → null）、白名单拆分/trim/过滤                        |
| 单测 `api`             | subscribe / respond 的帧构造（mock WebSocket，不真连企微）                         |
| 单测 `ws-client`       | 心跳触发、指数退避推进、disconnected_event 处理、消息解析（mock WebSocket）        |
| 单测 `adapter`         | 白名单判定、限流、userId→session 映射、未授权丢弃（mock deps）                     |
| 单测 `channel-message` | 骨架三频道一致性：白名单→限流→会话→回发（mock deps，参数化 feishu/telegram/wecom） |
| 集成                   | mock 企微消息回调 → adapter 跑 prompt → 回传（用测试 provider 不真调 LLM）         |
| 红队                   | 上线前 prompt-injection 对抗测试（CLAUDE.md 强制）                                 |

---

## 九、范围外（后续）

- 钉钉适配（第 4 个频道时抽完整 channel 接口）
- 流式回传（`aibot_respond_msg` 原生支持 `stream.id` 刷新，MVP 不做）
- 群聊支持（待企微修复普通成员消息回调 bug）
- 图片 / 文件 / 语音收发（`aibot_upload_media_*` 已具备能力）
- 交互卡片 / 完整「steer」
- 多机器人 / 多租户
- 长消息分片协议（MVP 直接截断）
