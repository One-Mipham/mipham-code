# Mipham Code v0.5.9

**Multi-model open-core intelligent coding terminal** — 9 AI providers, 66 commands, 16 tools, 14 skills + marketplace, self-update. AI-assisted code generation, security auditing, MCP protocol, and extensible skills — in a single CLI.

Built by [One Mipham Corporation](https://onemipham.com) (北京华安麦逄科技有限公司) | Brand: MiphamAI

## Quick Install

```bash
npm install -g @miphamai/cli
mipham
```

Requirements: **Bun 1.2+** (recommended) or **Node.js 22+**

## Features

- **9 AI Providers** — Anthropic Claude · OpenAI GPT · DeepSeek · Kimi (Moonshot) · Google Gemini · Doubao 豆包 · Tencent Hunyuan 混元 · Qwen 通义千问 · MiphamAI
- **66 Slash Commands** — Interactive command picker (↑↓ Enter Esc), Claude Code-compatible, zero re-learning
- **16 Built-in Tools** — File ops, shell execution, agent dispatch, MCP integration, web search
- **14 Skills + Marketplace** — 11 standard + 3 Mipham-exclusive skills. `/browse-skills` `/install-skill` community marketplace
- **Self-Update** — `mipham update` / `/upgrade` — one command to check, backup config, upgrade, restore. API keys preserved
- **Smart Recommendations** — `/recommend` analyzes your project, suggests skills, providers, and config
- **One-Click Config** — `/init` generates config.yml with all 9 providers pre-populated (just replace API keys)
- **MCP Protocol** — Full JSON-RPC 2.0 stdio transport for external server integration
- **Security Hardened** — Path sandbox · SSRF protection · Bash blacklist · Permission gating · Parameter validation · command injection prevention · API key redaction
- **Config Resilience** — YAML error recovery, deep merge providers, auto-backup (5 copies), corruption auto-restore
- **Session Persistence** — Auto-save/restore across CLI restarts, named sessions, checkpoint/rewind
- **Cross-Platform** — macOS · Linux · Windows

## Quick Start

```bash
mipham

# First run auto-initializes config. Or:
/init     # Generate ~/.mipham/config.yml with 9 providers pre-configured

# Set API keys (env vars or config.yml)
export DEEPSEEK_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."

# Interactive model picker
Ctrl+P

# Browse and install community skills
/browse-skills
/install-skill systematic-debugging

# Get project-specific recommendations
/recommend

# Self-update
mipham update
```

## Commands

| Category | Commands                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Session  | `/help` `/version` `/clear` `/exit` `/quit` `/compact` `/context` `/status` `/cost` `/rename` `/goal` `/recap` `/export` `/doctor` `/resume` |
| Model    | `/pick` `/model` `/models` `/provider` `/providers` `/switch` `/fast` `/effort` `/theme` `/upgrade`                                          |
| Skills   | `/skills` `/browse-skills` `/install-skill` `/remove-skill` `/reload-skills`                                                                 |
| Tools    | `/tools` `/commands` `/mcp`                                                                                                                  |
| Workflow | `/plan` `/no-plan` `/review` `/diff` `/todos` `/tasks` `/workflows` `/loop` `/agents`                                                        |
| Project  | `/init` `/setup` `/recommend` `/security` `/audit` `/permissions` `/add-dir`                                                                 |
| History  | `/rewind` `/undo` `/copy` `/focus`                                                                                                           |

Press **Ctrl+P** for model picker · **Shift+Tab** to cycle permission mode · **/** for command picker

## Resources

- [Website (International)](https://mipham.ai/mipham-code)
- [国内站](https://onemipham.com/mipham-code)
- [GitHub](https://github.com/One-Mipham/mipham-code)
- [Product Specification](https://github.com/One-Mipham/mipham-code/blob/main/PRODUCT.md)
- [npm](https://www.npmjs.com/package/@miphamai/cli)

## License

Apache 2.0 — Open Core
