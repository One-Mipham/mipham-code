# Mipham Code Feishu Bot 远程控制

> **版本**: 1.0.0
> **日期**: 2026-08-18
> **状态**: 设计完成，待实现
> **参考**: ZCode（智谱 zcode.z.ai/cn）的「Bot 控制」能力（微信/飞书/Telegram 远程唤起+指挥）
> **路线图**: 实现计划见 `docs/superpowers/plans/2026-08-18-feishu-bot-remote-control.md`（writing-plans 阶段产出）

---

## 一、目标

在 Mipham Code 现有 **Daemon 后台持久化架构** 之上，新增 **飞书（Feishu/Lark）远程控制** 能力：用户通过飞书自建应用给 Bot 发消息，Bot 在后台跑 Mipham Code 会话并把结果回传。

- 每个飞书用户映射到一个**持久会话**（多轮对话，Bot 记得上下文）
- 复用 Daemon 已有的会话 / 引擎 / 限流 / 鉴权能力
- 安全优先：事件验签 + 用户白名单 + 最小权限 + 内容过滤

**非目标（范围外）**：工具审批交互按钮（完整「steer」）、交互卡片、微信 / Telegram / 企业微信。

---

## 二、设计决策

| 维度     | 选择                                                      | 理由                                                                                                                    |
| -------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| IM 平台  | 飞书 **企业自建应用**（非群自定义机器人）                 | 自定义机器人只推不收，收不到用户消息；自建应用订阅 `im.message.receive_v1` 事件才能「远程指挥」                         |
| 交互深度 | **多轮会话**（每用户一个持久 session）                    | 打通「远程指挥」核心；完整操控（审批按钮）留后续                                                                        |
| 部署落点 | 公司腾讯云服务器（onemipham.com 同机）                    | TLS/域名/PM2 现成，复用 daemon                                                                                          |
| 架构     | **A — daemon 内 `feishu/` 模块**，挂 `/feishu/event` 路由 | 复用 `engineCache`/`SessionManager`/`RateLimiter`/鉴权，单进程单部署；模块边界保证后续可拆独立 gateway（strangler fig） |
| 事件加密 | 官方 SDK **`@larksuiteoapi/node-sdk`**（MIT）             | 事件解密 / 验签 / challenge 是安全关键路径，SDK 正确性有保证，不手写 crypto                                             |
| 权限模式 | `default`（headless 最小权限）                            | daemon 会话无弹窗，ask 级工具（Bash/Write/Edit）默认拦，防注入越权                                                      |

---

## 三、进程拓扑

```
┌──────────────────────────────────────────────────────────────┐
│                     飞书用户（手机/桌面）                        │
│   发消息 → 飞书服务器 → POST /feishu/event（加密）              │
└──────────────────────────────────────────────────────────────┘
                              │ 公网 HTTPS（腾讯云，TLS 已备）
                              ▼
┌──────────────────────────────────────────────────────────────┐
│              Daemon 进程（腾讯云服务器，PM2 常驻）                │
│                                                              │
│   ┌────────────────────────────────────────────┐              │
│   │  server.ts  ── /feishu/event 路由           │              │
│   │     │                                       │              │
│   │     ▼                                       │              │
│   │  feishu/ 模块                                │              │
│   │   crypto.ts（SDK 解密+验签+challenge）        │              │
│   │   adapter.ts（open_id 鉴权 → session 映射）   │              │
│   │   api.ts（tenant_access_token + 发消息）      │              │
│   └──────┬─────────────────────────────────────┘              │
│          │ 复用（in-process，无 HTTP 往返）                      │
│   ┌──────▼─────────────────────────────────────┐              │
│   │  SessionManager + WorkerPool + engineCache   │              │
│   │  RateLimiter + authMiddleware                │              │
│   │  SQLite（sessions/messages/...）              │              │
│   └──────────────────────────────────────────────┘             │
└──────────────────────────────────────────────────────────────┘
```

---

## 四、组件

### 4.1 `src/daemon/feishu/crypto.ts` — 事件安全

- 封装 `@larksuiteoapi/node-sdk` 的事件处理：
  - **URL challenge**：回显 `challenge` 字段（配置回调 URL 时飞书发起）
  - **事件解密**：AES-256-CBC 解密 `encrypt` 字段（SDK 用 Encrypt Key 处理）
  - **签名校验**：`X-Lark-Signature` = SHA256(timestamp + nonce + encrypt_key + body)

### 4.2 `src/daemon/feishu/adapter.ts` — 业务编排

- 解析 `im.message.receive_v1` 事件 → 提取 `sender.sender_id.open_id` + 文本内容
- **open_id 白名单鉴权**（`FEISHU_ALLOWED_OPEN_IDS`）
- `open_id → sessionId` 映射：sessions 表加 `feishuOpenId` 可空字段 + 唯一索引，get-or-create 按 open_id 查询
- 调 `SessionWorker.processPrompt(prompt)`，完成后取 `engine.getLastAssistantContent()`
- 调 `api.ts` 回传结果

### 4.3 `src/daemon/feishu/api.ts` — 飞书 API

- `getTenantAccessToken()`：`POST /open-apis/auth/v3/tenant_access_token/internal`（app_id + app_secret）
- `sendText(openId, text)`：`POST /open-apis/im/v1/messages?receive_id_type=open_id`

### 4.4 `server.ts` 挂载

- 新增 `POST /feishu/event` 路由（在 authMiddleware 之前独立处理，因飞书签名 ≠ daemon Bearer token）
- 配置项从 env 读取，构造 `FeishuAdapter` 传入 `createServer`

---

## 五、数据流

```
1. 飞书用户发消息（1:1 或 @Bot）
   ↓
2. 飞书服务器 POST /feishu/event（encrypt 密文 + 签名头）
   ↓
3. crypto.ts 验签 + 解密 → 事件 JSON
   ↓
4. adapter.ts 提取 open_id + 文本
   ↓
5. 白名单鉴权：open_id 不在 FEISHU_ALLOWED_OPEN_IDS → 静默丢弃（或回「未授权」）
   ↓
6. open_id → session（无则 db 新建 session）
   ↓
7. worker.processPrompt(text)（in-process，直接 await 完成——不走 HTTP prompt 端点，避开其 fire-and-forget 拿不到结果的问题）
   ↓
8. 取 engine.getLastAssistantContent() 作为最终回复
   ↓
9. api.ts 发消息回飞书（tenant_access_token + receive_id=open_id）
```

---

## 六、安全模型

| 威胁                      | 防御                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 伪造事件 / 重放           | SDK 验签 + 解密 + timestamp/nonce 校验                                                                                          |
| 未授权用户指挥            | `FEISHU_ALLOWED_OPEN_IDS` 白名单（仅 Bot 所有者/授权成员）                                                                      |
| Prompt injection 越权执行 | daemon 会话 `default` 权限（headless 无弹窗，ask 级 Bash/Write/Edit 拦）+ 白名单；上线前过 CLAUDE.md 红队 prompt-injection 测试 |
| 洪水 / 滥用               | 复用 `RateLimiter`（按 open_id 为 key，独立限额）                                                                               |
| 有害/敏感输出             | 响应内容过滤（NSFW / PII），对齐 CLAUDE.md AI 安全                                                                              |
| 密钥泄漏                  | `FEISHU_APP_ID/SECRET/ENCRYPT_KEY/VERIFICATION_TOKEN` 全 env 注入，禁止硬编码/日志                                              |

**依赖合规**：`@larksuiteoapi/node-sdk` 为 MIT 许可，通过 CLAUDE.md 许可证检查（无 copyleft/GPL）。

---

## 七、错误处理

| 场景               | 处理                                  |
| ------------------ | ------------------------------------- |
| 解密/验签失败      | 4xx 返回，不处理、不回传（可能伪造）  |
| open_id 未授权     | 静默丢弃（不回传，避免探测白名单）    |
| 引擎初始化失败     | 回传「引擎初始化失败」友好文案        |
| 会话关闭/异常      | 回传错误摘要（截断，不泄漏内部堆栈）  |
| 飞书 API 超时/限流 | 指数退避重试（最多 N 次），失败记日志 |

---

## 八、测试策略

| 层             | 内容                                                                                    |
| -------------- | --------------------------------------------------------------------------------------- |
| 单测 `crypto`  | 用 SDK 固定测试密钥：challenge 回显、解密、验签（mock SDK 输入/输出）                   |
| 单测 `adapter` | open_id 白名单判定、open_id→session 映射（get-or-create）、未授权丢弃                   |
| 单测 `api`     | tenant_access_token 获取 + 发消息（mock fetch）                                         |
| 集成           | mock 飞书事件 → `/feishu/event` → daemon 跑 prompt → 回传（用测试 provider 不真调 LLM） |
| 红队           | 上线前 prompt-injection 对抗测试（CLAUDE.md 强制）                                      |

---

## 九、范围外（后续）

- 工具审批交互卡片（完整「steer」）
- 群机器人、微信 / Telegram / 企业微信适配
- 多 Bot / 多租户、SSO 集成
- 结果流式回传（MVP 一次性回传最终文本）
