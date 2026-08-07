# Mipham Code — Phase 9 MCP 深度集成 + 1M 上下文设计 Spec

> **版本**: 1.0.0
> **日期**: 2026-08-07
> **阶段**: Phase 9 — MCP 深度集成 + 1M 上下文窗口
> **维护人**: One Mipham Corporation 技术委员会

---

## 一、目标

两个独立子系统并行交付：

1. **MCP 深度集成** — OAuth PKCE 认证 + 动态工具更新 + 运行时服务器管理
2. **1M 上下文窗口** — 真实 tokenizer (js-tiktoken/cl100k_base) + 硬编码限制自适应升级

---

## 二、现状基线

### MCP 层

| 组件           | 文件                          | 能力                                           |
| -------------- | ----------------------------- | ---------------------------------------------- |
| StdioTransport | `mcp/transport.ts`            | 子进程 spawn，JSON-RPC 2.0，env sanitization   |
| McpProtocol    | `mcp/protocol.ts`             | initialize, listTools, callTool, listResources |
| McpClient      | `mcp/client.ts`               | 单例，多服务器管理，connect/disconnect         |
| Tool Registry  | `mcp/registry.ts`             | MCP tool → ToolDefinition 转换，工具注册       |
| ToolSearch     | `tools/system/tool-search.ts` | 按需工具发现                                   |

**缺口**: 无 OAuth，无 `list_changed` 处理，无运行时服务器管理，工具仅启动时注册。

### 上下文层

| 组件                 | 文件                           | 能力                                 |
| -------------------- | ------------------------------ | ------------------------------------ |
| ContextManager       | `core/context.ts`              | 消息管理、四层压缩、chars/4 估算     |
| context-snip         | `core/context-snip.ts`         | 零成本空工具对裁剪                   |
| context-microcompact | `core/context-microcompact.ts` | 工具结果压缩，cache-aware            |
| context-compact      | `core/context-compact.ts`      | LLM 摘要，20 条保留，2000 chars 上限 |
| context-drain        | `core/context-drain.ts`        | 413 恢复，四级排水                   |

**缺口**: chars/4 启发式不准，摘要/截断/记忆预算硬编码偏低，大窗口下阈值不自适应。

---

## 三、子项 1 — MCP 深度集成

### 3.1 OAuth PKCE 认证

**新增文件**: `apps/cli/src/mcp/oauth.ts`

**流程**:

```
1. 用户执行 /mcp connect <name>
2. 读取 McpServerConfig.auth 配置
3. 生成 code_verifier (crypto.randomBytes(64) → base64url, 128 bytes raw)
4. 计算 code_challenge: SHA-256(verifier) → base64url
5. 构建 authorization URL:
   {auth.authorizationUrl}?
     response_type=code&
     client_id={auth.clientId}&
     code_challenge={challenge}&
     code_challenge_method=S256&
     redirect_uri=http://localhost:{port}/callback&
     scope={auth.scopes?.join(' ')}
6. 启动本地 HTTP 服务器 (http.createServer, port default 19876)
7. 打开浏览器到 authorization URL
8. 监听 GET /callback?code=...&state=...
9. 用 code + verifier POST {auth.tokenUrl}:
   { grant_type: 'authorization_code', code, code_verifier, redirect_uri }
10. 收到 { access_token, refresh_token?, expires_in? }
11. 加密存储到 ~/.mipham/mcp-tokens/<server>.enc (AES-256-GCM, chmod 600)
12. 使用 access_token 通过 stdio transport 的 env 传递: MCP_ACCESS_TOKEN=<token>
```

**配置扩展** (`McpServerConfig`):

```typescript
auth?: {
  type: 'oauth'
  authorizationUrl: string   // OAuth 授权端点
  tokenUrl: string           // OAuth token 端点
  clientId: string           // 客户端 ID
  scopes?: string[]          // OAuth scopes
  redirectPort?: number      // 回调端口，默认 19876
}
```

**Token 存储** (`~/.mipham/mcp-tokens/`):

```json
{
  "<server>": {
    "accessToken": "<encrypted>",
    "refreshToken": "<encrypted>",
    "expiresAt": "2026-08-07T14:00:00Z",
    "createdAt": "2026-08-07T10:00:00Z",
    "scopes": ["tools.read", "tools.write"]
  }
}
```

**安全措施**:

- Token 文件 `chmod 600`
- Token 值使用 AES-256-GCM 加密（密钥从 `~/.mipham/.mcp-key` 读取，若不存在则生成）
- 加密密钥文件 `chmod 400`
- 过期的 access token 自动使用 refresh token 刷新
- OAuth state 参数防 CSRF（随机 32 bytes）

### 3.2 动态工具更新

**修改文件**: `apps/cli/src/mcp/protocol.ts`, `apps/cli/src/mcp/client.ts`

**3.2.1 tools/list_changed 通知处理**

在 `McpProtocol` 中注册 notification handler:

```
服务器 → notifications/tools/list_changed → McpProtocol
  → 触发 McpClient.onToolsChanged(serverName)
    → 重新调用 listTools()
    → diff 新旧工具列表
    → 调用 registerMcpServerTools() 注册新增
    → 调用 unregisterMcpServerTools() 移除已删除
```

**3.2.2 断线重连**

```
transport.onClose → McpClient.autoReconnect(name)
  → backoff: 1s → 2s → 4s → 8s → 16s → max 60s
  → 每次尝试: transport.start() → protocol.initialize() → protocol.listTools()
  → 成功: re-register all tools, reset backoff
  → 失败: continue backoff, max 10 attempts then give up
```

**3.2.3 McpClient 新增方法**

```typescript
class McpClient {
  // 触发完整的 OAuth 连接流程
  async connectWithOAuth(config: McpServerConfig): Promise<ConnectionInfo>

  // 断开并尝试重连
  async reconnect(name: string): Promise<ConnectionInfo>

  // 处理 tools 变更通知
  onToolsChanged(name: string): Promise<void>

  // 获取 token（自动 refresh 过期 token）
  async getAccessToken(name: string): Promise<string>

  // 连接状态事件
  on(
    event: 'tools-changed',
    handler: (name: string, added: string[], removed: string[]) => void,
  ): void
  on(event: 'reconnected', handler: (name: string) => void): void
  on(event: 'disconnected', handler: (name: string, error: Error) => void): void
}
```

### 3.3 运行时服务器管理

**新增 Slash 命令**（修改 `commands.ts`）:

| 命令                     | 行为                        |
| ------------------------ | --------------------------- |
| `/mcp connect <name>`    | OAuth 完整流程或 stdio 直连 |
| `/mcp disconnect <name>` | 断开连接 + 清理注册工具     |
| `/mcp reload`            | 断开所有 + 重新连接所有     |

**现有 `/mcp` 命令增强**:

- 显示 OAuth 状态（是否认证、token 过期时间）
- 显示工具数量 + 重连状态
- 运行时可添加/移除服务器配置

### 3.4 改动文件

| 文件                     | 改动类型 | 说明                                 |
| ------------------------ | -------- | ------------------------------------ |
| `src/mcp/oauth.ts`       | **新建** | OAuth PKCE 流程 + token 管理         |
| `src/mcp/token-store.ts` | **新建** | 加密 token 持久化                    |
| `src/mcp/protocol.ts`    | 修改     | 注册 notification handler            |
| `src/mcp/client.ts`      | 修改     | reconnect, oauth, tools-changed 事件 |
| `src/mcp/registry.ts`    | 修改     | 运行时 re-register + diff            |
| `src/shared/types.ts`    | 修改     | McpServerConfig.auth 字段            |
| `src/ui/commands.ts`     | 修改     | /mcp connect/disconnect/reload       |
| `src/config/loader.ts`   | 修改     | 读取 mcp-tokens 目录                 |

### 3.5 测试

- OAuth PKCE 流程单元测试（mock HTTP server + token endpoint）
- Token 存储加密/解密测试
- tools/list_changed 处理测试
- 断线重连（指数退避）测试
- /mcp connect/disconnect 命令测试

---

## 四、子项 2 — 1M 上下文窗口

### 4.1 真实 Tokenizer

**新增文件**: `apps/cli/src/core/tokenizer.ts`

**方案**: `js-tiktoken` — WASM 版 tiktoken，cl100k_base encoding

```typescript
export class TokenCounter {
  private encoder: Tiktoken

  constructor() {
    // 延迟初始化，首次调用时加载 WASM
  }

  count(text: string): number
  countMessages(messages: Message[]): number
  truncateToTokens(text: string, maxTokens: number): string
}
```

**集成点**:

| 位置                                       | 当前                           | 改为                                 |
| ------------------------------------------ | ------------------------------ | ------------------------------------ |
| `ContextManager.estimateTokens()`          | chars/4 启发式（含 CJK 1.5）   | `tokenCounter.count(text)`           |
| `context-token.ts estimateMessageTokens()` | 相同启发式                     | `tokenCounter.countMessages()`       |
| `ContextManager.addMessage()`              | 手动 +=                        | 调用 tokenCounter 更新 running total |
| `memory-manager.ts` 记忆注入               | 5000 chars → ~1250 tokens 估计 | 精确 token 计数                      |

**延迟加载策略**: TokenCounter 在首次 `addMessage()` 时初始化。避免 CLI 启动时的 WASM 加载延迟。

**性能**:

- cl100k_base tokenize: ~1M chars/s（WASM 单线程）
- 1M 上下文 tokenize: ~1s 首次，后续增量 <1ms/message
- 消息 token count 缓存（Map<messageId, number>），避免重复计算

### 4.2 硬编码限制升级

| #   | 位置                    | 限制项                | 当前值     | 新值                          | 理由                      |
| --- | ----------------------- | --------------------- | ---------- | ----------------------------- | ------------------------- |
| L1  | `engine.ts:223`         | Summarizer max_tokens | 300        | 2000                          | 1M 窗口下摘要需要更多空间 |
| L2  | `context-compact.ts:46` | Summarizer 输出 cap   | 2000 chars | 8000 chars                    | 与 L1 匹配                |
| L3  | `engine.ts:207`         | 每条消息摘要截断      | 500 chars  | 2000 chars                    | 保留语义完整性            |
| L4  | `memory-manager.ts:178` | 记忆注入 token 预算   | 5000       | max(contextWindow×0.05, 5000) | 自适应                    |
| L5  | `context-compact.ts:19` | 压缩保留消息数        | 20         | max(20, contextWindow/50000)  | 大窗口保更多              |
| L6  | `context.ts:100`        | compact() 最小消息数  | 30         | max(30, contextWindow/33000)  | 大上下文晚压缩            |
| L7  | `context.ts:289`        | microcompact 阈值     | 0.7 (70%)  | 自适应                        | 见 4.3                    |

### 4.3 自适应阈值

新增 `ContextManager` 行为 — 阈值随 context window 大小动态调整：

```typescript
// 在 updateMaxTokens() 或构造时计算

// 压缩阈值: 窗口越大越晚压缩
//   200K → 0.90,  500K → 0.93,  1M → 0.95
compactionThreshold = Math.max(0.9, 1 - 50000 / maxTokens)

// 微压缩阈值: 窗口越大越晚微压缩
//   200K → 0.70,  500K → 0.80,  1M → 0.85
microcompactThreshold = Math.max(0.7, 1 - 150000 / maxTokens)
```

### 4.4 改动文件

| 文件                                | 改动类型 | 说明                                |
| ----------------------------------- | -------- | ----------------------------------- |
| `src/core/tokenizer.ts`             | **新建** | tiktoken TokenCounter 封装          |
| `src/core/context.ts`               | 修改     | 替换 estimateTokens，自适应阈值     |
| `src/core/context-token.ts`         | 修改     | 替换 estimateMessageTokens          |
| `src/core/engine.ts`                | 修改     | L1 summarizer 300→2000，L3 500→2000 |
| `src/core/context-compact.ts`       | 修改     | L2 2000→8000，L5 保留数自适应       |
| `src/core/memory/memory-manager.ts` | 修改     | L4 预算自适应                       |
| `package.json` (apps/cli)           | 修改     | 添加 `js-tiktoken` 依赖             |

### 4.5 测试

- TokenCounter.count() vs 已知 token count（与 OpenAI tokenizer 交叉验证）
- TokenCounter.countMessages() 多语言混合文本
- 自适应阈值：1M/500K/200K/128K 窗口下的 compaction/microcompact 阈值
- context compact 后摘要不超 cap
- 记忆注入不超自适应预算
- 回归：所有现有 ContextManager 测试（60 tests）仍通过

---

## 五、交付顺序

```
子项 1 (MCP 深度集成)          子项 2 (1M 上下文)
    │                               │
    ├── Task 1: OAuth 认证          ├── Task 5: Tokenizer
    ├── Task 2: 动态工具更新        ├── Task 6: 限制升级
    ├── Task 3: 运行时管理          ├── Task 7: 自适应阈值
    └── Task 4: MCP 测试            └── Task 8: 上下文测试
```

MCP 和 1M 完全独立，可并行实现，同属一个 Phase 9 分支。

### 预估工作量

| 子系统       | 新建文件 | 修改文件 | 新增代码       | 新增测试      |
| ------------ | -------- | -------- | -------------- | ------------- |
| MCP 深度集成 | 2        | 5        | ~400 lines     | ~40 tests     |
| 1M 上下文    | 1        | 5        | ~250 lines     | ~25 tests     |
| **合计**     | **3**    | **10**   | **~650 lines** | **~65 tests** |

---

## 六、风险与回滚

| 风险                                       | 缓解                                          |
| ------------------------------------------ | --------------------------------------------- |
| js-tiktoken WASM 加载慢 → CLI 启动慢       | 延迟初始化，首条消息时才加载                  |
| OAuth local server 端口冲突                | 可配置 redirectPort，fallback 随机端口        |
| 动态工具更新触发过于频繁                   | 防抖 1 秒，连续通知合并                       |
| Token count 变更导致现有上下文管理行为变化 | 保留 chars/4 作为 fallback，feature flag 控制 |

Feature flag: `~/.mipham/config.json` 新增:

- `mcp.oauthEnabled` (default: true)
- `context.useRealTokenizer` (default: true)
- `context.adaptiveThresholds` (default: true)

---

## 七、不做什么（明确排除）

- ❌ 不做 WebSocket/HTTP MCP transport — 保持 stdio 单一传输层
- ❌ 不做完整的 OAuth 2.1 规范（device flow, client credentials）— 仅 PKCE
- ❌ 不做 MCP Resource 订阅 — Resource 已有 list/read，订阅超出范围
- ❌ 不做多 encoder 支持（不同模型不同 tokenizer）— cl100k_base 覆盖所有目标模型
- ❌ 不做 token count 可视化 UI — 后端能力优先
- ❌ 不做上下文窗口动态扩展（hot resize）— 初始化时确定，switch 时更新

---

### 修订历史

| 版本  | 日期       | 变更内容                                         | 维护人     |
| ----- | ---------- | ------------------------------------------------ | ---------- |
| 1.0.0 | 2026-08-07 | 初版：MCP OAuth+动态工具 + 1M tokenizer+限制升级 | 技术委员会 |
