# Mipham Code v0.5.9 — 你的全能 AI 编程终端，正式发布

> 多模型 · 开源核心 · 安全加固 · 66 条命令 · 14 项技能 · 9 家 AI 厂商一键切换 · 一键自更新
> 北京华安麦逄科技有限公司 | 品牌: MiphamAI

---

## 一句话介绍

**Mipham Code** 是一个开源（Apache 2.0）的多模型智能编程终端。它把 Anthropic Claude、OpenAI GPT、DeepSeek、通义千问、豆包、腾讯混元、Google Gemini 等 **8 家顶级 AI 模型**统一到一个命令行界面中，让你在编码、调试、安全审计、项目管理之间无缝切换——零学习成本。

```
npm install -g @miphamai/cli
mipham
```

一行命令，即刻拥有专属 AI 编程助手。

---

## 为什么你需要 Mipham Code？

| 痛点                  | Mipham Code 怎么解决                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| 多个 AI 工具来回切换  | **8 家厂商、28+ 模型**，Ctrl+P 一键切换，不离开终端                    |
| 代码安全没保障        | **五层安全防护**：路径沙箱、SSRF 防护、Bash 黑名单、权限门控、参数校验 |
| 对话上下文太长会丢失  | **自动压缩 + 检查点 + 会话持久化**，长对话不丢失                       |
| 想用 MCP 协议扩展能力 | **完整 JSON-RPC 2.0 实现**，接入任何 MCP 兼容服务器                    |
| 社区工具不够用        | **14 个内置技能** + 可扩展的技能市场，代码审查、安全审计、TDD 全搞定   |

---

## 核心特性

### 🤖 9 家 AI 模型，一键切换

| 厂商             | 代表模型                          | 接入方式    |
| ---------------- | --------------------------------- | ----------- |
| Anthropic Claude | Opus 4.8 · Sonnet 4.6 · Haiku 4.5 | Native SDK  |
| DeepSeek         | V4 Pro · V4 Flash                 | OpenAI 兼容 |
| OpenAI           | GPT-5.5 · GPT-5.4 · Codex         | OpenAI 兼容 |
| 通义千问 (Qwen)  | Plus · Max                        | OpenAI 兼容 |
| 豆包 (ByteDance) | Seed 2.0 系列 (6 个)              | OpenAI 兼容 |
| 腾讯混元         | TurboS · 2.0 · T1 (8 个)          | OpenAI 兼容 |
| Kimi (月之暗面)  | Kimi Latest · Moonshot v1 系列    | OpenAI 兼容 |
| Google Gemini    | 3.0 Flash/Pro · 2.5 Pro           | OpenAI 兼容 |
| MiphamAI         | OM V5 Flash/Pro/Visual            | 即将上线    |

### 🛠 16 个内置工具

```
文件操作:  Read · Write · Edit · Glob · Grep
命令执行:  Bash · Git · Task
智能代理:  Agent · Skill · Plan · Memory
网络:      WebFetch · WebSearch
系统:      Config · MCP
```

### ⌨ 66 条斜杠命令 + 交互式选择器

完全对齐 Claude Code 体验，零重新学习成本。输入 `/` 弹出交互式命令选择器，↑↓ 光标选择，Enter 确认，支持实时过滤：

```
/help · /commands · /clear · /compact · /context · /status
/model · /models · /switch · /pick · /tools · /skills
/review · /pr-comments · /diff · /plan · /setup · /doctor
/browse-skills · /install-skill · /remove-skill · /recommend
/upgrade · /agents · /bg · /export · /resume · /memory
```

🆕 v0.5.9 新增：`/browse-skills`（社区技能市场）、`/install-skill`（一键安装技能）、`/recommend`（智能项目分析推荐）

### 🎯 14 个内置技能 + 社区技能市场

内置技能（11 standard + 3 mipham）: code-review、security-review、tdd、doc-generator……

🆕 **技能市场**：`/browse-skills` 浏览社区技能，`/install-skill <name>` 一键安装。首批 8 个社区技能（含 Anthropic 官方 systematic-debugging、TDD、frontend-design）

### 🔄 一键自更新

`mipham update` 或 `/upgrade` 命令自动检查 npm registry 最新版本，备份配置文件，执行升级。升级过程中 `~/.mipham/config.yml`（含 API Key）自动保护不丢失。

### 🛡 配置容错 + 安全加固

- YAML 语法错误不崩溃，损坏时自动从备份恢复
- 启动时自动备份配置（保留 5 份历史）
- API Key 未设置或环境变量缺失时友好提示
- `/init` 一键生成预配置 9 家 provider 的 config.yml
- 命令注入防护、SSRF 防护、密钥输出脱敏

### 🎯 14 个内置技能

标准技能（11 个）: code-review、security-review、tdd、doc-generator、github-ops、memory、web-search……

Mipham 专属（3 个）: om-security（注入检测+对抗鲁棒性）、om-model-optimize（上下文优化+缓存策略）、om-artifact

### 🔒 五层安全防护

1. **路径沙箱** — 防目录遍历攻击
2. **URL 校验** — 拦截内网 IP、file:// 协议
3. **Bash 黑名单** — 8 个危险模式 + 7 个禁用命令
4. **权限门控** — auto / ask / bypass 三级，Shift+Tab 一键切换
5. **参数校验** — JSON Schema 注册层验证

---

## 安装方式

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
# 国际站
irm https://mipham.ai/install.ps1 | iex

# 中国大陆
irm https://onemipham.com/install.ps1 | iex
```

### 直接下载二进制

macOS / Linux / Windows 二进制文件：
👉 [GitHub Releases (v0.5.9)](https://github.com/One-Mipham/mipham-code/releases)

---

## 快速上手

### 第一步：设置 API Key

```bash
export DEEPSEEK_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
```

### 第二步：启动

```bash
mipham
```

### 第三步：开始对话

```
> 帮我审查 src/auth 模块的安全漏洞
> 为这个项目生成 API 文档
> 用 TDD 方式实现用户注册功能
```

**Ctrl+P** 切换模型 · **Shift+Tab** 切换权限模式 · **/help** 查看所有命令

---

## 技术亮点

- **运行时**: Bun 1.2+（原生 TS 支持，冷启动 ~400ms）
- **CLI 框架**: React 18 + Ink 5（终端 UI）
- **流式响应**: SSE 实时输出，首 token < 2s
- **MCP 协议**: 完整 JSON-RPC 2.0 stdio 传输层
- **测试覆盖**: 563 个测试，CI/CD 五阶段流水线
- **跨平台**: macOS / Linux / Windows 全支持
- **开源协议**: Apache 2.0

---

## 资源链接

| 资源      | 链接                                        |
| --------- | ------------------------------------------- |
| 🌐 国际站 | https://mipham.ai/mipham-code               |
| 🇨🇳 国内站 | https://onemipham.com/mipham-code           |
| 📦 npm    | https://www.npmjs.com/package/@miphamai/cli |
| 💻 GitHub | https://github.com/One-Mipham/mipham-code   |
| 📧 反馈   | feedback@mipham.ai                          |

---

_Mipham Code — 以慈悲之心构建，以纪律之魂交付。_
_Built with compassion, shipped with discipline._
