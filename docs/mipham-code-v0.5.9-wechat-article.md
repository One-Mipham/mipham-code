# Mipham Code v0.5.9 — 你的全能 AI 编程终端，正式发布

> 多模型 · 开源核心 · 安全加固 · 66 条命令 · 14 项技能 · 9 家 AI 厂商一键切换 · 一键自更新
> 北京华安麦逄科技有限公司 | 品牌: MiphamAI

---

## 一句话介绍

**Mipham Code** 是一个开源（Apache 2.0）的多模型智能编程终端。它把 Anthropic Claude、OpenAI GPT、DeepSeek、通义千问、豆包、腾讯混元、Kimi、Google Gemini 等 **9 家顶级 AI 模型**统一到一个命令行界面中，让你在编码、调试、安全审计、项目管理之间无缝切换——零学习成本。

```
npm install -g @miphamai/cli
mipham
```

一行命令，即刻拥有专属 AI 编程助手。

---

## 为什么你需要 Mipham Code？

| 痛点 | Mipham Code 怎么解决 |
|------|---------------------|
| 多个 AI 工具来回切换 | **9 家厂商、32+ 模型**，Ctrl+P 一键切换，不离开终端 |
| 代码安全没保障 | **五层安全防护**：路径沙箱、SSRF 防护、Bash 黑名单、权限门控、参数校验 |
| 对话上下文太长会丢失 | **自动压缩 + 检查点 + 会话持久化**，长对话不丢失上下文 |
| 想用 MCP 协议扩展能力 | **完整 JSON-RPC 2.0 实现**，接入任何 MCP 兼容服务器 |
| 社区工具不够用 | **14 个内置技能 + 社区技能市场**，一键安装 Anthropic 官方技能 |
| 手动升级太麻烦 | **`mipham update` 一键自更新**，config.yml（API Key）自动保护不丢失 |
| 配置繁琐容易出错 | **`/init` 一键生成** 9 家 provider 全预置配置，只需替换 API Key |

---

## 核心特性

### 🤖 9 家 AI 模型，一键切换

`Ctrl+P` 打开交互式选择器，↑↓ 选择，Enter 切换。所有模型共享同一套工具、技能和命令体系。

| 厂商 | 代表模型 | 接入方式 | API Key 获取 |
|------|---------|---------|-------------|
| Anthropic Claude | Opus 4.8 · Sonnet 4.6 · Haiku 4.5 | Native SDK | https://console.anthropic.com/ |
| OpenAI | GPT-5.5 · GPT-5.4 · GPT-5.3 Codex | OpenAI 兼容 | https://platform.openai.com/api-keys |
| DeepSeek | V4 Pro (1M ctx) · V4 Flash (1M ctx) | OpenAI 兼容 | https://platform.deepseek.com/api_keys |
| Kimi (月之暗面) 🆕 | Kimi Latest · Moonshot v1 (8K/32K/128K) | OpenAI 兼容 | https://platform.moonshot.cn/ |
| 通义千问 (Qwen) | Qwen Plus · Qwen Max | OpenAI 兼容 | https://dashscope.console.aliyun.com/apiKey |
| 豆包 (ByteDance) | Seed 2.0 Pro/Code/Lite/Mini · Seed 1.6/Flash | OpenAI 兼容 | https://console.volcengine.com/ark |
| 腾讯混元 | TurboS · 2.0 Instruct/Think · T1 Vision · Hy3 | OpenAI 兼容 | https://console.cloud.tencent.com/hunyuan |
| Google Gemini | 3.0 Flash/Pro · 2.5 Pro | OpenAI 兼容 | https://aistudio.google.com/apikey |
| MiphamAI | OM V5 Flash/Pro/Visual | 即将上线 | — |

### ⚡ 配置模板 — 30 秒上手

运行 `/init` 或 `mipham` 首次启动时，自动生成 `~/.mipham/config.yml`，**9 家 provider 已全部预配置 baseUrl 和 API Key 占位符**，只需：

```yaml
# ~/.mipham/config.yml（自动生成，只需替换 API Key）

providers:
  # Get key: https://platform.deepseek.com/api_keys
  - id: deepseek
    name: "DeepSeek"
    baseUrl: "https://api.deepseek.com/v1"
    apiKey: "${DEEPSEEK_API_KEY}"    # ← 替换为你的 Key

  # Get key: https://console.anthropic.com/
  - id: anthropic
    name: "Anthropic Claude"
    apiKey: "${ANTHROPIC_API_KEY}"   # ← 替换为你的 Key
  # ... 其余 7 家同理
```

也支持环境变量：`export DEEPSEEK_API_KEY="sk-..."`

---

## 🛠 16 个内置工具

AI 模型可以通过工具调用直接操作你的项目文件、执行命令和管理任务：

### 文件操作 (5)
| 工具 | 功能 | 示例 |
|------|------|------|
| **Read** | 读取文件内容 | `"读取 src/auth.ts"` |
| **Write** | 创建/覆盖文件 | `"创建 React 组件 UserProfile"` |
| **Edit** | 精确替换文件内容 | `"把第 42 行的 useState 改成 useReducer"` |
| **Glob** | 按模式查找文件 | `"找到所有 .test.ts 文件"` |
| **Grep** | 按内容搜索代码 | `"搜索项目中所有 TODO 注释"` |

### 命令执行 (3)
| 工具 | 功能 |
|------|------|
| **Bash** | 执行 Shell 命令（经过安全审查） |
| **Git** | 版本控制操作（commit, branch, diff） |
| **Task** | 后台任务管理（启动、停止、查看状态） |

### 智能代理 (4)
| 工具 | 功能 |
|------|------|
| **Agent** | 启动子代理处理复杂多步任务 |
| **Skill** | 调用已安装的技能 |
| **Plan** | 进入只读规划模式，设计后再实施 |
| **Memory** | 持久化记忆，跨会话保存关键信息 |

### 网络 (2)
| 工具 | 功能 |
|------|------|
| **WebFetch** | 抓取网页内容 |
| **WebSearch** | 搜索互联网信息 |

### 系统 (2)
| 工具 | 功能 |
|------|------|
| **Config** | 查看和修改配置 |
| **MCP** | MCP 协议服务器管理 |

---

## ⌨ 66 条斜杠命令 + 交互式选择器

🆕 **v0.5.9 新特性**：输入 `/` 弹出交互式命令选择器，↑↓ 移动光标，Enter 选中，支持实时过滤。完全对齐 Claude Code 体验。

### 会话与身份 (18)
`/help` `/version` `/clear` `/exit` `/quit` `/compact` `/context` `/status` `/cost` `/usage` `/rename` `/goal` `/recap` `/export` `/doctor` `/resume` `/branch` `/pick`

### 模型与 Provider (10)
`/model` `/models` `/provider` `/providers` `/config` `/fast` `/effort` `/theme` `/upgrade` `/switch`

### 工具与技能 (7)
`/tools` `/skills` `/reload-skills` `/browse-skills` 🆕 `/install-skill` 🆕 `/remove-skill` 🆕 `/commands` `/mcp`

### 工作流 (11)
`/plan` `/no-plan` `/tdd` `/todos` `/tasks` `/review` `/pr-comments` `/diff` `/workflows` `/loop` `/agents`

### 项目 (7)
`/init` `/setup` `/recommend` 🆕 `/permissions` `/add-dir` `/security` `/audit`

### 历史与会话 (4)
`/rewind` `/undo` `/copy` `/focus`

### 环境 (4)
`/ide` `/terminal-setup` `/memory` `/release-notes`

### 账户 (3)
`/login` `/logout` `/feedback`

### Artifacts (1)
`/artifact`

---

## 🎯 14 个内置技能 + 社区技能市场

### 内置技能

**Standard 技能（11 个）**：
| 技能 | 用途 |
|------|------|
| `code-review` | 多维度自动化代码审查 |
| `systematic-debugging` | 系统化调试：先找根因再修复 |
| `test-driven-development` | TDD 工作流：先写测试再实现 |
| `security-review` | 安全审计和漏洞扫描 |
| `doc-generator` | 生成 API 文档、README、Changelog |
| `github-ops` | GitHub PR/Issue 管理和自动化 |
| `memory` | 持久化记忆管理 |
| `web-search` | 联网搜索 |
| `self-review` | 自我审查和反思 |
| `superpower` | 超级能力增强 |
| `compassionate-communication` | 慈悲沟通模式 |

**Mipham 专属技能（3 个）**：
| 技能 | 用途 |
|------|------|
| `om-security` | Prompt 注入检测 + 对抗攻击鲁棒性 + 内容安全过滤 |
| `om-model-optimize` | 上下文窗口优化 + 缓存策略 + Token 节省 |
| `om-artifact` | 交互式 HTML/SVG 构件生成和管理 |

### 🆕 社区技能市场（v0.5.9）

`/browse-skills` 浏览社区技能，`/install-skill <name>` 一键安装，`/remove-skill <name>` 卸载。

首批 8 个社区技能：

| 技能 | 作者 | 分类 |
|------|------|------|
| `code-review` | MiphamAI | 开发 |
| `systematic-debugging` | Anthropic | 开发 |
| `test-driven-development` | Anthropic | 开发 |
| `web-access` | MiphamAI | 网络 |
| `doc-generator` | MiphamAI | 文档 |
| `github-ops` | MiphamAI | DevOps |
| `security-review` | MiphamAI | 安全 |
| `frontend-design` | Anthropic | 设计 |

也支持从 URL 直接安装：`/install-skill https://github.com/user/skill-repo/blob/main/my-skill.SKILL.md`

---

## 🔄 一键自更新（v0.5.9 新功能）

```bash
mipham update
```

或在 Mipham Code 交互界面中输入 `/upgrade`：

1. 自动查询 npm registry 最新版本
2. 对比本地版本，告知是否有更新
3. 自动备份 `~/.mipham/config.yml`（含 API Key）
4. 执行 `npm install -g @miphamai/cli@latest`
5. 验证配置文件完好无损，如有意外自动恢复

更新过程**不丢失任何 API Key 配置**。

---

## 🛡 安全防护体系

### 五层安全防护

| 层级 | 机制 | 防护对象 |
|------|------|---------|
| 1. 路径沙箱 | 所有文件操作限制在项目目录内 | 目录遍历攻击 |
| 2. URL 校验 | 拦截内网 IP、file://、非白名单域名 | SSRF 攻击 |
| 3. Bash 黑名单 | 8 个危险模式 + 7 个禁用命令 | 命令注入 |
| 4. 权限门控 | auto / ask / bypass 三级，`Shift+Tab` 切换 | 未授权操作 |
| 5. 参数校验 | JSON Schema 注册层验证所有工具输入 | 畸形参数 |

### 配置安全（v0.5.9 强化）

- **YAML 容错**：语法错误不崩溃，打印友好警告并继续启动
- **深合并**：修改 apiKey 不会丢失 provider 的模型定义
- **自动备份**：每次启动备份 `config.yml`，保留 5 份历史
- **损坏恢复**：配置文件损坏时自动从最新备份恢复
- **权限保护**：备份文件 `chmod 600`（仅 owner 可读写）
- **密钥脱敏**：`/security` 命令输出中 API Key 自动显示为 `[VALUE REDACTED]`
- **环境变量警告**：引用未设置的 `$ENV_VAR` 时明确提示

---

## 安装方式

### 前置要求

- **macOS** / **Linux** / **Windows**
- Bun 1.2+（推荐）或 Node.js 22+

### npm（推荐）

```bash
npm install -g @miphamai/cli
mipham
```

### curl 一键安装

```bash
# 国际站
curl -fsSL https://mipham.ai/install.sh | bash

# 中国大陆
curl -fsSL https://onemipham.com/install.sh | bash
```

### Windows PowerShell

```powershell
irm https://onemipham.com/install.ps1 | iex
```

### 直接下载二进制

👉 [GitHub Releases (v0.5.9)](https://github.com/One-Mipham/mipham-code/releases)

---

## 快速上手

### 第一步：获取 API Key

推荐 DeepSeek（国内访问快，1M 上下文，价格低）：

```bash
# 注册获取 Key: https://platform.deepseek.com/api_keys
export DEEPSEEK_API_KEY="sk-..."
```

### 第二步：启动

```bash
mipham
```

首次启动自动初始化。或运行 `/init` 生成完整配置文件。

### 第三步：开始对话

```
▸ ~/my-project
  帮我审查 src/auth 模块的安全漏洞

▸ ~/my-project
  为这个项目生成完整的 API 文档

▸ ~/my-project
  用 TDD 方式实现用户注册功能，先写测试
```

### 常用快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+P` | 切换 AI 模型 |
| `Shift+Tab` | 切换权限模式（auto → ask → bypass） |
| `Esc` | 取消当前操作 / 退出 |
| `↑` `↓` | `/` 命令选择器中导航 |
| `Ctrl+O` | 展开/折叠工具调用详情 |

---

## 🆕 v0.5.9 更新日志

### 新功能
- **`mipham update` / `/upgrade`**：一键自更新，config.yml 自动备份保护
- **CommandPicker**：交互式斜杠命令选择器（↑↓ 光标 + Enter 选择 + 实时过滤）
- **技能市场**：`/browse-skills` `/install-skill` `/remove-skill` — 首批 8 个社区技能
- **`/recommend`**：智能项目分析 — 检测技术栈 → 推荐 Skills / Provider / 配置
- **Kimi (月之暗面)** provider：4 个模型，baseUrl api.moonshot.cn
- **`/init` 重写**：一键生成 9 家 provider 全预置 config.yml

### 配置容错
- YAML 语法错误不崩溃
- Provider 深合并（改 apiKey 不丢模型定义）
- 启动时自动备份配置（保留 5 份）
- 配置损坏从备份自动恢复
- API Key 缺失 / 环境变量未设友好警告

### UX 改进
- 对话标签 "You" → 当前目录路径
- 斜杠命令提示改为垂直字母序排列

### 安全加固
- 命令注入防护（spawnSync + semver/包名校验）
- SSRF 防护（HTTPS-only + 域名白名单）
- 密钥输出脱敏（`/security` 显示 `[VALUE REDACTED]`）
- 备份/配置文件 `chmod 600`

---

## 📋 v0.5.8 更新日志（昨日）

- **deploy-guard 预检查**：防止 Nginx 配置被意外覆盖
- **config 加载容错**：`openai-compat` / `openai-compatible` 均可接受；`baseUrl` / `baseURL` 大小写兼容；`$VAR` / `${VAR}` 双语法
- **v0.5.8 微信推广文章** 发布
- 版本号升至 0.5.8

---

## 技术架构

```
mipham-code/
├── apps/
│   ├── cli/          ← CLI 终端（Bun + React/Ink）
│   │   ├── bin/      → 入口（commander + update 子命令）
│   │   ├── src/core/ → engine, context, permission, hooks
│   │   ├── src/providers/ → 9 家 AI 厂商适配
│   │   ├── src/tools/ → 16 个工具
│   │   ├── src/skills/ → skill 加载器 + 注册表
│   │   └── src/ui/   → app, chat, input, picker, commands
│   └── web/          ← Web 产品页（Next.js）
├── packages/shared/  ← 共享类型、常量、package-info
└── infrastructure/   ← Homebrew formula
```

| 技术层 | 选型 |
|--------|------|
| 运行时 | Bun 1.2+ / Node.js 22+ |
| CLI 框架 | React 18 + Ink 5 |
| 语言 | TypeScript 5.5+ strict |
| 测试 | Vitest 3（563 个测试） |
| CI/CD | GitHub Actions 五阶段流水线 |
| 包管理 | pnpm 9.15 |
| 许可 | Apache 2.0 |

---

## 资源链接

| 资源 | 链接 |
|------|------|
| 🌐 国际站 | https://mipham.ai/mipham-code |
| 🇨🇳 国内站 | https://onemipham.com/mipham-code |
| 📦 npm | https://www.npmjs.com/package/@miphamai/cli |
| 💻 GitHub | https://github.com/One-Mipham/mipham-code |
| 📖 文档 | https://mipham.ai/mipham-code/docs |
| 📥 安装指南 | https://mipham.ai/mipham-code/install |
| 📧 反馈 | feedback@mipham.ai |

---

_Mipham Code — 以慈悲之心构建，以纪律之魂交付。_
_Built with compassion, shipped with discipline._
