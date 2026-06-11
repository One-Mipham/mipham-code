# Mipham Code — Product Specification

> **Version**: 1.0.0 | **Date**: 2026-06-10 | **Status**: Production-Ready
> **License**: Apache 2.0 | **Owner**: One Mipham Corporation (北京华安麦逄科技有限公司)
> **Brand**: MiphamAI | **Product Page**: [mipham.ai/code](https://mipham.ai/code)

---

## 1. Product Overview 产品概述

Mipham Code is an **open-core, multi-model intelligent coding terminal** that provides a unified interface to top AI models through a React/Ink CLI. It combines AI-assisted code generation, security auditing, MCP protocol integration, and an extensible skills system into a single terminal application.

Mipham Code 是一个**开源核心、多模型智能编程终端**，通过 React/Ink CLI 提供统一的 AI 模型接口。它将 AI 辅助代码生成、安全审计、MCP 协议集成和可扩展技能系统融合于一个终端应用中。

### 1.1 Key Capabilities 核心能力

| Capability              | Description                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| **Multi-Model**         | 7 providers, 28+ models via unified API (Anthropic, OpenAI, DeepSeek, Google, Qwen, Doubao, Hunyuan) |
| **16 Built-in Tools**   | File operations, shell execution, agent dispatch, MCP integration, web search                        |
| **60 Slash Commands**   | Full Claude Code-compatible command set with zero re-learning                                        |
| **MCP Protocol**        | Full JSON-RPC 2.0 stdio transport — connect to any MCP-compatible server                             |
| **14 Skills**           | 12 standard + 2 Mipham-exclusive skills with dual-runtime architecture                               |
| **Security Hardened**   | Path sandbox, SSRF protection, Bash command blacklist, permission gating, parameter validation       |
| **Session Persistence** | Auto-save/restore across CLI sessions via JSONL store                                                |
| **Cross-Platform**      | macOS, Linux, Windows via npm / curl / PowerShell / direct download                                  |

### 1.2 Brand Positioning 品牌定位

```
Product:  Mipham Code
Brand:    MiphamAI (One Mipham Corporation)
Tagline:  Multi-Model Open-Core Intelligent Coding Terminal
         多模型开源核心智能编程终端

International:  https://mipham.ai/code       (Global, GitHub, npm)
China Mainland: https://onemipham.com/code     (中国大陆，访问更快)
```

---

## 2. Installation 安装方式

### 2.1 npm (Recommended 推荐)

```bash
npm install -g @onemipham/cli
mipham
```

### 2.2 curl (macOS / Linux)

```bash
# International 国际站
curl -fsSL https://mipham.ai/install.sh | bash

# China mainland 中国大陆
curl -fsSL https://onemipham.com/install.sh | bash
```

### 2.3 Windows PowerShell

```powershell
# International
irm https://mipham.ai/install.ps1 | iex

# China mainland
irm https://onemipham.com/install.ps1 | iex
```

### 2.4 Direct Download 直接下载

| Platform              | Download                                   |
| --------------------- | ------------------------------------------ |
| macOS (Apple Silicon) | `https://mipham.ai/dl/mipham-darwin-arm64` |
| macOS (Intel)         | `https://mipham.ai/dl/mipham-darwin-x64`   |
| Linux (x64)           | `https://mipham.ai/dl/mipham-linux-x64`    |
| Windows (x64)         | `https://mipham.ai/dl/mipham-win-x64.exe`  |

### 2.5 Runtime Requirements 运行环境

| Runtime | Version | Notes                                         |
| ------- | ------- | --------------------------------------------- |
| Bun     | ≥1.2.0  | Recommended — native TS support, fast startup |
| Node.js | ≥22.0.0 | Compatible, best with Bun installed alongside |

---

## 3. Architecture 系统架构

```
┌─────────────────────────────────────────────┐
│                  CLI Entry                    │
│           bin/mipham → src/index.tsx          │
├─────────────────────────────────────────────┤
│              UI Layer (React/Ink)             │
│    app.tsx · chat.tsx · input.tsx · picker    │
├─────────────────────────────────────────────┤
│    Commands (60)    │    Skills (14)          │
│    commands.ts       │    skills/standard/     │
│                      │    skills/mipham/       │
├─────────────────────────────────────────────┤
│          Core Engine                          │
│  engine.ts · context.ts · permission.ts       │
│  hooks.ts · instructions.ts · session-store   │
├──────────────┬──────────────────────────────┤
│  Tools (16)  │  Providers (7)                │
│  file/exec/  │  anthropic (native SDK)       │
│  agent/net/  │  openai-compat × 5            │
│  system/     │  mipham (upcoming)            │
├──────────────┴──────────────────────────────┤
│  Security Layer                              │
│  path.ts · url.ts · bash blacklist           │
├─────────────────────────────────────────────┤
│  MCP Client                                  │
│  transport.ts · protocol.ts · client.ts      │
│  types.ts · mock-server.ts                   │
├─────────────────────────────────────────────┤
│  Sub-Agent Engine                            │
│  sub-agent.ts (general/explore/plan/review)   │
└─────────────────────────────────────────────┘
```

### 3.1 Design Principles 设计原则

1. **Simplicity First** — Minimal code, no premature abstraction
2. **Surgical Changes** — Only modify what's required, match existing style
3. **Security by Default** — Path sandbox, permission gates, SSRF protection built-in
4. **Multi-Model First** — Every feature works across all 7 providers
5. **Zero Re-Learning** — Commands mirror Claude Code UX

---

## 4. Provider System 模型供应商

### 4.1 Active Providers (7)

| #   | Provider                 | Protocol      | API Key Env Var     | Active Models                         |
| --- | ------------------------ | ------------- | ------------------- | ------------------------------------- |
| 1   | Anthropic Claude         | Native SDK    | `ANTHROPIC_API_KEY` | Haiku 4.5, Sonnet 4.6, Opus 4.8       |
| 2   | DeepSeek                 | OpenAI Compat | `DEEPSEEK_API_KEY`  | V4 Flash, V4 Pro                      |
| 3   | Google Gemini            | OpenAI Compat | `GEMINI_API_KEY`    | 3.0 Flash/Pro, 2.5 Pro                |
| 4   | ByteDance Doubao 豆包    | OpenAI Compat | `DOUBAO_API_KEY`    | Seed 1.6/2.0 series (6 models)        |
| 5   | Tencent Hunyuan 腾讯混元 | OpenAI Compat | `HUNYUAN_API_KEY`   | Lite, TurboS, 2.0, T1, Hy3 (8 models) |
| 6   | OpenAI                   | OpenAI Compat | `OPENAI_API_KEY`    | GPT-5.4 Mini, GPT-5.4, GPT-5.5, Codex |
| 7   | Qwen 通义千问            | OpenAI Compat | `QWEN_API_KEY`      | Qwen Plus, Qwen Max                   |

### 4.2 Upcoming Provider

| #   | Provider | Protocol      | Status                              |
| --- | -------- | ------------- | ----------------------------------- |
| 8   | MiphamAI | OpenAI Compat | Upcoming — OM V5 Flash, Pro, Visual |

### 4.3 Model Selection

- **Ctrl+P** — Interactive two-panel model picker
- `/pick` — Same as Ctrl+P
- `/switch <provider> <model>` — Direct switch
- `/model` — Show current model
- `/models` — List all available

---

## 5. Tools System 工具系统

### 5.1 Tool Registry (16 tools)

| Category        | Tool      | Permission | Description                           |
| --------------- | --------- | ---------- | ------------------------------------- |
| **File (5)**    | Read      | auto       | Read files with offset/limit          |
|                 | Write     | ask        | Write/create files with path sandbox  |
|                 | Edit      | ask        | Exact string replacement              |
|                 | Glob      | auto       | Pattern-based file search             |
|                 | Grep      | auto       | ripgrep-powered content search        |
| **Exec (3)**    | Bash      | ask        | Shell execution with safety blacklist |
|                 | Git       | ask        | Git operations                        |
|                 | Task      | ask        | Background task management            |
| **Agent (4)**   | Agent     | ask        | Sub-agent dispatch (4 types)          |
|                 | Skill     | auto       | Skill invocation via loader           |
|                 | Plan      | auto       | Structured plan file generation       |
|                 | Memory    | auto       | Persistent memory read/write          |
| **Network (2)** | WebFetch  | auto       | URL fetch with SSRF protection        |
|                 | WebSearch | auto       | Web search                            |
| **System (2)**  | Config    | auto       | Configuration management              |
|                 | MCP       | ask        | MCP server tool execution             |

### 5.2 Security Controls

Every tool execution is gated by:

1. **Path Sandbox** — `resolveSafe()` prevents traversal attacks
2. **URL Validator** — Blocks internal IPs, `file://` protocol
3. **Bash Blacklist** — 8 dangerous patterns + 7 blocked commands
4. **Permission Gate** — `PermissionSystem.check()` before each execution
5. **Parameter Validation** — JSON Schema validation at the registry level

---

## 6. Command Reference 命令参考

### 6.1 Session & Identity (15 commands)

| Command          | Description              |
| ---------------- | ------------------------ |
| `/help`          | Show all commands        |
| `/version`       | Version info             |
| `/clear`         | Clear conversation       |
| `/compact`       | Compact context window   |
| `/context`       | Context statistics       |
| `/status`        | Session status           |
| `/cost`          | Token usage estimate     |
| `/usage`         | Detailed usage dashboard |
| `/rename <n>`    | Rename session           |
| `/goal <text>`   | Set session goal         |
| `/recap`         | Session summary          |
| `/export`        | Export to file           |
| `/doctor`        | System diagnostics       |
| `/resume [name]` | List/resume sessions     |
| `/branch <name>` | Fork conversation        |

### 6.2 History (4 commands)

| Command     | Description        |
| ----------- | ------------------ |
| `/rewind`   | Undo last AI turn  |
| `/undo`     | Same as /rewind    |
| `/copy [N]` | Copy last response |
| `/focus`    | Toggle focus view  |

### 6.3 Model & Provider (9 commands)

| Command           | Description           |
| ----------------- | --------------------- |
| `/pick`           | Open model picker     |
| `/model`          | Show current model    |
| `/models`         | List all models       |
| `/provider`       | Show current provider |
| `/providers`      | List providers        |
| `/switch <p> <m>` | Switch provider/model |
| `/config`         | View config           |
| `/fast [on\|off]` | Toggle fast mode      |
| `/effort <lvl>`   | Set reasoning effort  |

### 6.4 Tools & Skills (5 commands)

| Command                      | Description       |
| ---------------------------- | ----------------- |
| `/tools`                     | List 16 tools     |
| `/skills`                    | List 14 skills    |
| `/reload-skills`             | Reload skills     |
| `/mcp`                       | MCP server status |
| `/theme [dark\|light\|auto]` | Theme settings    |

### 6.5 Workflow (9 commands)

| Command        | Description      |
| -------------- | ---------------- |
| `/plan`        | Enter plan mode  |
| `/no-plan`     | Exit plan mode   |
| `/tdd`         | TDD workflow     |
| `/todos`       | Task management  |
| `/tasks`       | Background tasks |
| `/review`      | Code review      |
| `/pr-comments` | PR review        |
| `/diff`        | Show git diff    |
| `/workflows`   | Workflow scripts |

### 6.6 Project & Environment (11 commands)

| Command           | Description         |
| ----------------- | ------------------- |
| `/init`           | Initialize config   |
| `/setup [1-6]`    | Setup wizard        |
| `/permissions`    | Permission settings |
| `/add-dir <dir>`  | Add workspace dir   |
| `/security`       | Security checklist  |
| `/audit`          | Same as /security   |
| `/upgrade`        | Upgrade guide       |
| `/release-notes`  | Changelog           |
| `/ide`            | IDE integration     |
| `/terminal-setup` | Shell config        |
| `/memory`         | Memory management   |

### 6.7 Account (4 commands)

| Command           | Description       |
| ----------------- | ----------------- |
| `/login`          | API key status    |
| `/logout`         | Clear credentials |
| `/feedback [msg]` | Send feedback     |
| `/agents`         | Agent management  |

---

## 7. Skills System 技能系统

### 7.1 Standard Skills (12)

| Skill                         | Version | Description                                           |
| ----------------------------- | ------- | ----------------------------------------------------- |
| `code-review`                 | 2.0.0   | 7-dimension code review with language-specific checks |
| `compassionate-communication` | 1.0.0   | MIPHAM.md v2.0 personality framework                  |
| `doc-generator`               | 1.0.0   | Technical documentation generation                    |
| `github-ops`                  | 1.0.0   | GitHub PR/issues/releases management                  |
| `memory`                      | 1.0.0   | Persistent memory across sessions                     |
| `mipham-code-setup`           | 1.0.0   | Installation and configuration guide                  |
| `security-review`             | 1.0.0   | OWASP Top 10, secrets, supply chain audit             |
| `self-review`                 | 1.0.0   | Self-review diff for bugs and cleanup                 |
| `superpower`                  | 1.0.0   | Skill discovery and usage guide                       |
| `tdd`                         | 1.0.0   | Test-Driven Development workflow                      |
| `web-search`                  | 1.0.0   | Web search integration                                |

### 7.2 Mipham Exclusive Skills (2)

| Skill               | Description                                                              |
| ------------------- | ------------------------------------------------------------------------ |
| `om-security`       | Prompt injection detection, adversarial robustness, data leak prevention |
| `om-model-optimize` | Context optimization, caching strategies, token management               |

### 7.3 Dual-Runtime Architecture

```
skills/
├── standard/           # Community-open *.SKILL.md files
│   ├── code-review.SKILL.md
│   └── ... (12 files)
├── mipham/             # MiphamAI proprietary *.mipham-skill.md files
│   ├── om-security.mipham-skill.md
│   └── om-model-optimize.mipham-skill.md
└── custom/             # User project skills (.mipham/skills/)
```

---

## 8. MCP Integration MCP 集成

### 8.1 Protocol Support

| Feature                            | Status            |
| ---------------------------------- | ----------------- |
| JSON-RPC 2.0 over stdio            | ✅ Full           |
| `initialize` handshake             | ✅                |
| `tools/list` discovery             | ✅                |
| `tools/call` execution             | ✅                |
| `resources/list`                   | ✅                |
| `resources/read`                   | ✅ Protocol layer |
| `notifications/tools/list_changed` | 🔶 Pending        |

### 8.2 Transport Architecture

```
McpClient (singleton)
  ├── Transport Layer (StdioTransport)
  │   └── Node.js child_process.spawn (cross-runtime)
  ├── Protocol Layer (McpProtocol)
  │   └── initialize → tools/list → tools/call
  └── Tool Integration
      └── MCP Tool (src/tools/system/mcp.ts)
```

### 8.3 Configuration

```yaml
# .mipham/config.yml
skills:
  mcpServers:
    - name: filesystem
      command: npx
      args: ['-y', '@anthropic/mcp-filesystem', '/path/to/allowed/dir']
    - name: github
      command: npx
      args: ['-y', '@anthropic/mcp-github']
      env:
        GITHUB_TOKEN: $GITHUB_TOKEN
```

---

## 9. Security Model 安全模型

### 9.1 Defense Layers

```
Layer 1: Path Sandbox (resolveSafe)
  ├── Workspace boundary enforcement
  ├── Symlink resolution (realpathSync)
  └── Sensitive path blocking (/etc, /proc, /sys)

Layer 2: URL Validation (validateUrl)
  ├── Protocol allow-list (http, https only)
  ├── Private IP blocking (IPv4 + IPv6)
  └── DNS rebinding protection

Layer 3: Bash Blacklist
  ├── 8 dangerous regex patterns
  └── 7 blocked commands (mkfs, dd, etc.)

Layer 4: Permission Gate
  ├── PermissionSystem.check() before every tool execution
  ├── 3 modes: auto (execute freely), ask (confirm), bypass (skip all)
  └── Per-tool rule overrides

Layer 5: Parameter Validation
  └── JSON Schema validation at registry level
```

### 9.2 Auto Mode Cycling

- **Shift+Tab** — Cycle permission mode: **auto → ask → bypass → auto**
- Status bar shows current mode with color indicator:
  - 🟢 `auto mode on` — Tools execute freely (default)
  - 🟡 `ask mode` — Confirm each tool execution
  - 🔴 `bypass mode` — Skip all permission checks

### 9.3 Compliance

- TLS 1.3 for all external communication
- AES-256-GCM for data at rest
- No hardcoded credentials (all keys via env vars)
- Apache 2.0 license (no copyleft/GPL dependencies)
- PII/金融数据脱敏 before dev/test environments

---

## 10. Session Management 会话管理

### 10.1 Persistence

```
~/.mipham/
├── config.yml           # User configuration
├── sessions/            # Auto-saved sessions (JSONL)
│   ├── session-2026-06-10T10-30-00.jsonl
│   └── my-project.jsonl
├── memory/              # AI persistent memory
│   └── *.md
└── plans/               # Generated plan files
    └── plan-*.md
```

### 10.2 Lifecycle

1. **Startup** — Auto-load most recent session if `--resume` flag
2. **During Chat** — Checkpoint saved after each AI response
3. **Exit** — SIGINT/SIGTERM triggers auto-save
4. **Restore** — `/resume <name>` or `mipham --resume "<name>"`

---

## 11. Testing & Quality 测试与质量

### 11.1 Test Matrix

| Layer     | Test Files                                    | Tests         | Coverage                          |
| --------- | --------------------------------------------- | ------------- | --------------------------------- |
| Core      | context, hooks, permission, session-store     | 79            | Context, permissions, persistence |
| Providers | anthropic, openai-compat, registry, bootstrap | 66            | API communication, SSE streaming  |
| Tools     | file, exec, agent, network-system, skills     | 133           | Tool execution, security gates    |
| Security  | path, url, permission-gate                    | 45            | Attack vector prevention          |
| MCP       | transport, protocol, client                   | 26            | MCP protocol lifecycle            |
| E2E       | full-pipeline                                 | 8             | End-to-end conversation           |
| Sub-Agent | sub-agent                                     | 6             | Agent dispatch                    |
| **Total** | **21 files**                                  | **394 tests** | **0 failures**                    |

### 11.2 CI/CD Pipeline

```
typecheck → lint → format → build → test
```

Triggered on push/PR to main branch via GitHub Actions.

---

## 12. Performance 性能指标

| Metric          | Target | Current             |
| --------------- | ------ | ------------------- |
| CLI Cold Start  | <500ms | ~400ms (Bun)        |
| SSE First Token | <2s    | Depends on provider |
| Tool Execution  | <5s    | <1s (local tools)   |
| MCP Connect     | <3s    | ~1s                 |
| Session Save    | <100ms | <10ms               |
| Test Suite      | <60s   | ~25s                |

---

## 13. Roadmap 路线图

### Completed ✅

| Phase     | Milestone                                                                | Date       |
| --------- | ------------------------------------------------------------------------ | ---------- |
| Phase 1-3 | 55 slash commands + /setup wizard                                        | 2026-06-09 |
| Phase 4   | 5 stub→full commands (mcp, login, logout, feedback, agents)              | 2026-06-09 |
| Phase 5   | Security hardening (path sandbox, SSRF, bash blacklist, permission gate) | 2026-06-10 |
| Phase 6   | Full MCP stdio implementation (JSON-RPC 2.0 transport + protocol)        | 2026-06-10 |
| Phase 7   | Agent subsystem + session persistence + 3 new skills                     | 2026-06-10 |
| Phase 8   | npm publish, multi-platform install, auto mode UI                        | 2026-06-10 |

### In Progress 🔶

| Phase | Milestone                                   |
| ----- | ------------------------------------------- |
| M3    | Full AI agent orchestration (Workflow tool) |
| M3    | MCP notifications/list_changed              |
| M3    | Community Skills marketplace                |

### Planned 🔷

| Milestone          | Description                                   |
| ------------------ | --------------------------------------------- |
| npm Publish        | `@onemipham/cli` to npm registry              |
| macOS .app         | Bundle CLI as native macOS application        |
| Web UI             | Complete product pages at mipham.ai/code      |
| VS Code Extension  | Mipham Code in editor sidebar                 |
| JetBrains Plugin   | IntelliJ/WebStorm integration                 |
| CI/CD Auto-Release | GitHub Actions automated npm + binary release |

---

## 14. Contributing 贡献指南

### 14.1 Development Setup

```bash
git clone https://github.com/onemipham/mipham-code
cd mipham-code/apps/cli
bun install
bun dev
```

### 14.2 Commit Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: Phase N — description
fix: description
refactor: description
test: description
docs: description
```

### 14.3 Code Review Checklist

- [ ] Tests pass (`pnpm test` — 394 tests)
- [ ] Typecheck passes (`pnpm typecheck`)
- [ ] Security: no hardcoded secrets, path sandbox respected
- [ ] Permission: tool gating tested
- [ ] Backward compatible (existing commands/tools unchanged)

---

## 15. Support 支持

| Channel       | Link                                                 |
| ------------- | ---------------------------------------------------- |
| GitHub Issues | https://github.com/onemipham/mipham-code/issues      |
| Discussions   | https://github.com/onemipham/mipham-code/discussions |
| Email         | feedback@mipham.ai                                   |
| International | https://mipham.ai/code                               |
| 中国大陆      | https://onemipham.com/code                           |

---

_Mipham Code — built with compassion, shipped with discipline._
_Mipham Code — 以慈悲之心构建，以纪律之魂交付。_
