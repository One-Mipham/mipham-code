# Mipham Code — Enterprise Inference Hooks (DLP) Design Spec

> **版本**: 1.0.0
> **日期**: 2026-08-06
> **阶段**: Phase 1 — 客户端 DLP 拦截，协议对标 Claude Inference Hooks
> **维护人**: One Mipham Corporation 技术委员会

---

## 一、目标

为 Mipham Code 添加企业级 DLP（Data Loss Prevention）推理钩子。在每次模型 API 调用前，将完整对话转录发送到企业 DLP 安全服务器，获得 allow/deny 判决后才决定是否继续推理。

**Phase 1 范围**（本 spec）：
- 新增 `PreInference` hook 事件
- 对标 Claude Inference Hooks 的 HTTPS POST 协议（HMAC 签名、JSON payload）
- 可配置超时和 fail-open/fail-closed 策略
- 架构预留服务端扩展点（Phase 2）

**Phase 2 范围**（后续 spec）：
- 影子模式（observe-only）
- 百分比灰度
- 角色排除
- 审计日志
- 独立的 DLP 配置 UI

---

## 二、架构

```
┌─────────────────────────────────────────────────────┐
│                  Mipham Code CLI                     │
│                                                     │
│  engine.ts::process()                               │
│       │                                             │
│       ├── UserPromptSubmit hook (已有)               │
│       ├── context.addMessage()                       │
│       ├── compaction check                           │
│       ├── ★ PreInference hook (新增)                 │
│       │     ├── allow → 继续                         │
│       │     └── deny  → yield error, return          │
│       └── registry.chat() → Provider API             │
│                                                     │
│  ┌──────────────────────────┐                       │
│  │ InferenceHookTransport    │ (新建)               │
│  │ ├── 构建 transcript       │                      │
│  │ ├── HMAC 签名             │                      │
│  │ ├── HTTPS POST            │                      │
│  │ └── verdict 解析          │                      │
│  └──────────────────────────┘                       │
└─────────────────────────────────────────────────────┘
```

**关键设计决策**：
- PreInference 在 `UserPromptSubmit` 之后、`registry.chat()` 之前
- 与 UserPromptSubmit 互补：后者过滤用户输入，前者审查完整对话上下文含工具调用结果
- endpoint 未配置时自动跳过，零开销

---

## 三、协议规格

### 3.1 请求

```
POST <endpoint>
Content-Type: application/json
X-Mipham-Signature: t=<unix_timestamp>,v1=<hmac-sha256-hex>
User-Agent: MiphamCode/<version>
```

```json
{
  "type": "inference_check",
  "id": "evt_<uuid>",
  "created_at": "2026-08-06T10:30:00Z",
  "data": {
    "type": "pre_inference",
    "session_id": "ses_<id>",
    "organization_id": "<org_id>",
    "provider": "anthropic",
    "model": "claude-sonnet-5",
    "messages": [
      { "role": "user", "content": "..." },
      { "role": "assistant", "content": "..." }
    ],
    "tool_calls": [
      {
        "name": "Read",
        "input": { "file_path": "/path/to/file" },
        "result_preview": "first 2000 chars..."
      }
    ]
  }
}
```

**字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 固定 `"inference_check"` |
| `id` | string | 事件唯一 ID（UUID，用于去重） |
| `created_at` | string | ISO 8601 时间戳 |
| `data.type` | string | 固定 `"pre_inference"` |
| `data.session_id` | string | 当前会话 ID |
| `data.organization_id` | string | 组织 ID（从配置读取，可选） |
| `data.provider` | string | 当前模型 provider |
| `data.model` | string | 当前模型 ID |
| `data.messages` | array | 完整对话转录（不含 system role） |
| `data.tool_calls` | array | 最近一轮工具调用及结果预览（各截断 2000 字符） |

### 3.2 响应

**Allow**：
```json
{ "verdict": "allow" }
```
HTTP 200

**Deny**：
```json
{
  "verdict": "deny",
  "reason": "SSN pattern detected in prompt"
}
```
HTTP 403

**其他状态码**：按 `on_failure` 策略处理。

### 3.3 签名

对标 Standard Webhooks 规范：

```
X-Mipham-Signature: t=<unix_timestamp>,v1=<hmac_sha256_hex>
```

- `t` = Unix 时间戳（秒）
- `v1` = HMAC-SHA256(signing_secret, `t.<body>`)，hex 编码
- signing_secret 格式：`mis_<random>`（32+ 字符）
- DLP 服务器侧应在 5 分钟内容忍时间戳偏差（防重放）

---

## 四、配置

`~/.mipham/config.yml` 新增段：

```yaml
inference_hooks:
  # DLP 服务器端点（HTTPS 必需，为空则不触发）
  endpoint: "https://dlp.onemipham.com/dlp/inspect"

  # 签名密钥（格式 mis_<random>）
  signing_secret: "mis_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"

  # 超时（毫秒），默认 5000
  timeout: 5000

  # DLP 服务器不可用时的策略
  on_failure: "fail-closed"   # fail-closed | fail-open

  # 组织 ID（可选，附加到请求中）
  organization_id: "org_xxx"

  # 附加自定义头（可选）
  headers:
    X-Team: "engineering"
```

**默认值**（`config/defaults.ts`）：

```typescript
inference_hooks: {
  endpoint: '',           // 空 = 不触发
  signing_secret: '',
  timeout: 5000,
  on_failure: 'fail-closed',
  organization_id: '',
  headers: {},
}
```

---

## 五、类型定义

### 5.1 HookEvent 新增

```typescript
export type HookEvent =
  | ...  // 现有事件
  | 'PreInference'     // ★ 新增
```

### 5.2 InferenceHookConfig

```typescript
export interface InferenceHookConfig {
  endpoint: string
  signing_secret: string
  timeout: number
  on_failure: 'fail-closed' | 'fail-open'
  organization_id: string
  headers: Record<string, string>
}
```

### 5.3 InferenceCheckRequest / Response

```typescript
export interface InferenceCheckRequest {
  type: 'inference_check'
  id: string
  created_at: string
  data: {
    type: 'pre_inference'
    session_id: string
    organization_id?: string
    provider: string
    model: string
    messages: Array<{ role: string; content: string }>
    tool_calls: Array<{
      name: string
      input: Record<string, unknown>
      result_preview: string
    }>
  }
}

export interface InferenceCheckResponse {
  verdict: 'allow' | 'deny'
  reason?: string
}
```

---

## 六、实现文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `core/inference-hook.ts` | **新建** | DLP 传输层核心逻辑 |
| `shared/types.ts` | 修改 | 新增类型定义 |
| `core/hooks.ts` | 修改 | 新增 `executePreInference()` |
| `core/hooks-executor.ts` | 修改 | HTTP executor 增强（超时、fail 策略、HMAC） |
| `core/engine.ts` | 修改 | `process()` 插入 PreInference 检查点 |
| `config/loader.ts` | 修改 | 解析 `inference_hooks` 段 |
| `config/defaults.ts` | 修改 | 默认配置 |
| `core/__tests__/inference-hook.test.ts` | **新建** | 单元测试 |
| `core/__tests__/hooks.test.ts` | 修改 | PreInference 事件测试 |

---

## 七、测试计划

### 7.1 单元测试 (`inference-hook.test.ts`)

1. **transcript 构建** — 验证 messages 不含 system role
2. **工具调用提取** — 验证 tool_calls 正确从消息历史中提取
3. **HMAC 签名** — 验证签名格式和正确性
4. **响应解析** — allow/deny verdict 正确解析
5. **超时处理** — 模拟超时，验证 fail-closed 和 fail-open 行为
6. **网络错误** — 模拟连接失败，验证 fallback 策略

### 7.2 集成测试 (`hooks.test.ts`)

1. **PreInference 事件注册和触发**
2. **endpoint 为空时跳过**
3. **deny verdict 阻止模型调用**
4. **allow verdict 放行**

### 7.3 边界情况

- DLP 服务器返回非 JSON 响应
- DLP 服务器返回 200 但 body 格式错误
- signing_secret 为空时跳过签名
- 极长对话历史的 payload 大小

---

## 八、安全考虑

1. **signing_secret 存储** — 从 config.yml 读取，不硬编码；Phase 2 考虑从环境变量或密钥管理器读取
2. **HTTPS 强制** — endpoint 必须使用 HTTPS；开发环境 `localhost` 例外
3. **payload 截断** — tool call results 截断到 2000 字符，防止 payload 过大
4. **system prompt 不发送** — 对标 Claude，不暴露系统提示给 DLP 服务器
5. **超时保护** — 默认 5 秒，可配置；防止 DLP 服务器拖慢推理

---

## 九、Phase 2 预留

以下功能在架构上已预留扩展点，本次不实现：

| 功能 | 预留方式 |
|------|---------|
| 影子模式 | `InferenceHookConfig.mode: 'enforce' | 'shadow'` 字段预留 |
| 百分比灰度 | `InferenceHookConfig.rollout_percentage: 0-100` 字段预留 |
| 角色排除 | `InferenceHookConfig.exclude_roles: string[]` 字段预留 |
| 服务端拦截 | `InferenceHookTransport` 接口化，客户端实现可替换为服务端代理 |
| 多 endpoint | `endpoints[]` 数组预留，支持多 DLP 服务器链式调用 |

---

## 十、参考资料

- Claude Inference Hooks Beta (2026-08-05): 服务端 DLP 拦截层
- Standard Webhooks Specification: HMAC 签名规范
- Netskope One DLP On Demand: 兼容的 DLP 服务商
- Palo Alto Prisma AIRS: 兼容的 DLP 服务商
