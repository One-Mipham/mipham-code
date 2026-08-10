# Mipham Code Daemon 后台持久化架构

> **版本**: 1.0.0
> **日期**: 2026-08-11
> **状态**: 设计完成，待实现
> **参考**: prime-agent daemon 架构（安全边界独立设计）
> **路线图**: 下一步计划 §7

---

## 一、目标

将 Mipham Code 从单进程 TUI 升级为 **Daemon 驱动的全功能 AI 编程平台**：

- 终端断开后 Agent 会话持续运行，支持无缝重连
- 多会话并行，代理间直接通信
- 持久化 goals、定时调度、心跳检测
- HTTP + WebSocket API 供外部集成
- **安全约束**：保持现有 30 工具 + 6 级权限系统，不引入 IPython 自由执行模型

---

## 二、设计决策

| 维度 | 选择 |
|------|------|
| 范围 | C — 全功能平台（多会话、代理通信、定时调度、HTTP API） |
| IPC 协议 | localhost HTTP + WebSocket |
| 持久化 | SQLite (`~/.mipham/daemon.db`) |
| 生命周期 | 首次 `mipham` 自动启动；`mipham --no-daemon` 跳过 |
| 执行模型 | 保持现有工具系统（read/write/bash/edit/agent/...） + 6 级权限 |

---

## 三、进程拓扑

```
┌──────────────────────────────────────────────────────────────────┐
│                        用户终端                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                       │
│  │ mipham   │  │ mipham   │  │ mipham   │  ← 多个 CLI 客户端     │
│  │ (TUI)    │  │ attach   │  │ status   │                       │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                       │
│       │             │             │                              │
│       └─────────────┼─────────────┘                              │
│                     │ HTTP/WS (localhost:PORT)                   │
└─────────────────────┼────────────────────────────────────────────┘
                      │
┌─────────────────────┼────────────────────────────────────────────┐
│              Daemon 进程 (后台常驻)                                │
│                     │                                            │
│  ┌──────────────────┴──────────────────────────────────┐        │
│  │              HTTP + WebSocket Server                  │        │
│  └──────────────────┬──────────────────────────────────┘        │
│                     │                                            │
│  ┌──────────────────┴──────────────────────────────────┐        │
│  │              Session Manager                         │        │
│  │  - 会话 CRUD                                        │        │
│  │  - Worker 进程池管理                                  │        │
│  │  - 心跳检测 (会话存活)                                 │        │
│  │  - 自动 compact 触发                                  │        │
│  │  - 空闲超时 → 自动休眠                                │        │
│  └──────────────────┬──────────────────────────────────┘        │
│                     │                                            │
│  ┌──────────────────┴──────────────────────────────────┐        │
│  │              SQLite 持久化层                          │        │
│  │  sessions | messages | agents | goals | schedules    │        │
│  └─────────────────────────────────────────────────────┘        │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐       │
│  │              Session Worker 池                        │       │
│  │                                                      │       │
│  │  ┌─────────────────┐  ┌─────────────────┐            │       │
│  │  │ Worker 1         │  │ Worker 2         │  ...      │       │
│  │  │ Session: "feat-x"│  │ Session: "bug-y" │           │       │
│  │  │ Engine (tools)   │  │ Engine (tools)   │           │       │
│  │  │ Context Manager  │  │ Context Manager  │           │       │
│  │  │ Sub-agent tree   │  │ Sub-agent tree   │           │       │
│  │  │ Goals tracker    │  │ Goals tracker    │           │       │
│  │  └─────────────────┘  └─────────────────┘            │       │
│  └──────────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────────┘
```

### 端口分配

- Daemon HTTP/WS 端口：`45671`（`MIPHAM_PORT` 环境变量可覆盖）
- 端口冲突时自动递增查找（`45672`, `45673`, ...）

---

## 四、SQLite 数据模型

```sql
-- 会话表
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,          -- UUID
  name          TEXT NOT NULL,             -- 用户命名 / 自动生成
  cwd           TEXT NOT NULL,             -- 工作目录
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  status        TEXT DEFAULT 'active',     -- active | idle | compacting | closed
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  closed_at     TEXT,
  -- 统计
  turn_count    INTEGER DEFAULT 0,
  token_in      INTEGER DEFAULT 0,
  token_out     INTEGER DEFAULT 0
);

-- 消息表 (替代 JSONL)
CREATE TABLE messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,             -- user | assistant | system | tool
  content       TEXT NOT NULL,             -- JSON string (Message 对象)
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_messages_session ON messages(session_id, id);

-- 后台 Agent 表
CREATE TABLE agents (
  id            TEXT PRIMARY KEY,          -- UUID
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES agents(id), -- NULL = root agent
  agent_type    TEXT NOT NULL,             -- general | explore | plan | ...
  description   TEXT NOT NULL,
  status        TEXT DEFAULT 'running',    -- running | completed | failed
  kind          TEXT DEFAULT 'interactive',-- interactive | forked | attached
  worktree      TEXT,                      -- git worktree path
  branch        TEXT,
  pr_url        TEXT,
  created_at    TEXT NOT NULL,
  completed_at  TEXT,
  result        TEXT,
  error         TEXT
);
CREATE INDEX idx_agents_session ON agents(session_id);

-- Goals 表
CREATE TABLE goals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  description   TEXT NOT NULL,
  status        TEXT DEFAULT 'active',     -- active | completed | paused | cleared
  progress      TEXT,                      -- JSON: {current, total, note}
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 定时调度表
CREATE TABLE schedules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  cron_expr     TEXT NOT NULL,             -- 标准 5 字段 cron
  prompt        TEXT NOT NULL,             -- 要执行的 prompt
  enabled       INTEGER DEFAULT 1,
  last_fired    TEXT,
  next_fire     TEXT NOT NULL
);
```

### 迁移路径

现有 `~/.mipham/sessions/*.jsonl` 数据在首次 daemon 启动时自动迁移到 SQLite。

---

## 五、CLI 命令

### 启动与连接

```
mipham                          → 启动 TUI，自动连接 daemon（无 daemon 则自动启动）
mipham --no-daemon              → 纯本地模式，不连接 daemon（兼容旧行为）
```

### Daemon 管理

```
mipham daemon start             → 手动启动 daemon
mipham daemon stop              → 停止 daemon（等待活跃会话结束）
mipham daemon stop --force      → 强制停止（保存所有会话状态后退出）
mipham daemon status            → daemon 状态 + 活跃会话数 + 端口
mipham daemon restart           → 重启 daemon
```

### 会话管理

```
mipham attach                   → 列出活跃会话，交互式选择重连
mipham attach <session-id>      → 直接重连指定会话
mipham attach --latest          → 重连最近活跃会话
mipham sessions                 → 列出所有会话（活跃 + 已关闭）
mipham sessions --running       → 只看活跃会话
mipham sessions close <id>      → 关闭指定会话
```

### Agent 管理

```
mipham agents                   → 列出所有后台 agent（跨会话）
mipham agent <id>               → 查看 agent 详情
mipham agent message <id>       → 向 agent 发送消息
mipham agent stop <id>          → 停止 agent
```

### Goals

```
mipham goal list [session]      → 列出会话的 goals
mipham goal add <text>          → 添加 goal
mipham goal done <id>           → 标记完成
mipham goal pause <id>          → 暂停
```

### Schedules

```
mipham schedule list [session]  → 列出定时任务
mipham schedule add <cron> <prompt> → 添加定时任务
mipham schedule remove <id>     → 删除定时任务
```

---

## 六、REST API

### 会话

```
POST   /api/v1/sessions              创建会话
GET    /api/v1/sessions              列出会话 (?status=active)
GET    /api/v1/sessions/:id          会话详情
DELETE /api/v1/sessions/:id          关闭会话
POST   /api/v1/sessions/:id/prompt   发送 prompt
GET    /api/v1/sessions/:id/messages 获取消息历史 (?limit=100)
```

### Agent

```
POST   /api/v1/agents                创建 agent
GET    /api/v1/agents                列出 agent (?session=:id)
POST   /api/v1/agents/:id/message    向 agent 发消息
DELETE /api/v1/agents/:id            停止 agent
```

### Goals

```
GET    /api/v1/goals?session=:id     列出 goals
POST   /api/v1/goals                 创建 goal
PATCH  /api/v1/goals/:id             更新 goal
```

### Schedules

```
GET    /api/v1/schedules?session=:id  列出 schedules
POST   /api/v1/schedules              创建 schedule
DELETE /api/v1/schedules/:id          删除 schedule
```

### 系统

```
GET    /api/v1/health               daemon 健康状态
GET    /api/v1/stats                统计信息
WS     /api/v1/sessions/:id/stream  实时流 (token/工具调用/agent 事件)
```

### API 鉴权

- localhost 请求（127.0.0.1）无需鉴权
- 外部请求需 Bearer token（存储在 `~/.mipham/daemon.token`）
- 首次启动自动生成随机 token

---

## 七、安全设计

### 安全边界

| 层级 | 机制 |
|------|------|
| **网络** | 默认仅监听 `127.0.0.1`（`MIPHAM_BIND=0.0.0.0` 可覆盖） |
| **鉴权** | Bearer token，自动生成 64 字符随机令牌 |
| **工具执行** | 保持现有 6 级权限系统（default/acceptEdits/plan/auto/dontAsk/bypass） |
| **凭据保护** | Credential Masker 在 daemon 进程中同样生效 |
| **Hook 系统** | PreToolUse/PostToolUse hooks 在 daemon worker 中执行 |
| **进程隔离** | Worker 独立子进程；单个 worker 崩溃不影响其他会话 |
| **沙箱** | 不引入 IPython 自由执行模型；所有代码执行经过 bash 工具 + 权限检查 |

### 拒绝的攻击向量

- ❌ 不执行模型生成的 Python 代码（与 prime-agent 的核心区别）
- ❌ 不暴露文件系统 API 到 HTTP 层（仅通过工具系统间接访问）
- ❌ 不允许跨会话消息注入（agent 通信通过权限验证）

---

## 八、测试策略

| 层级 | 工具 | 内容 |
|------|------|------|
| **单元测试** | Vitest | SQLite 读写、Session Manager、Worker 生命周期、权限传递 |
| **集成测试** | Vitest + 临时端口 | HTTP API 端点、WebSocket 流、daemon 重启恢复 |
| **渗透测试** | 现有套件扩展 | Daemon API 鉴权、WebSocket 注入、会话劫持 |
| **压力测试** | 新增 | 100+ 并发会话、Worker 池耗尽恢复、SQLite 写入争用 |

---

## 九、分阶段实施

| 阶段 | 内容 | 文件估计 |
|------|------|---------|
| **Phase 1: Daemon 核心** | HTTP+WS server、Session Manager、SQLite schema、`mipham daemon start/stop/status` | ~8 文件 |
| **Phase 2: 会话持久化** | Session Worker、Engine 集成、WebSocket 实时流、`mipham attach`、compact | ~6 文件 |
| **Phase 3: Agent 系统** | Agent 表 + 注册、跨会话 agent 通信、`mipham agents` | ~5 文件 |
| **Phase 4: Goals + Schedules** | Goals CRUD、定时调度、心跳检测、自动续期 | ~4 文件 |
| **Phase 5: 外部 API** | REST API 鉴权、速率限制、API 文档 | ~3 文件 |

---

## 十、兼容性

| 项目 | 策略 |
|------|------|
| `mipham --no-daemon` | 保留旧行为，纯本地模式 |
| `~/.mipham/sessions/*.jsonl` | 首次启动自动迁移到 SQLite |
| `config.yml` | 不变，daemon 共享同一份配置 |
| 现有工具系统 | 完全兼容，session worker 复用同一 Engine |
| `mipham update` | daemon 先停止 → 更新 → 重启 daemon |
| VS Code / JetBrains 扩展 | 通过 HTTP API 集成 |

---

## 十一、参考

- [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) — Daemon 架构参考（MIT License）
- [Claude Code](https://claude.ai/code) — 行业终端 benchmark
- 本文件基于 [prime-agent 评估报告](wiki/incidents/mipham-code-update-timeout-v0.31.0.md) 的建议编写
