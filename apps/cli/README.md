# Mipham Code

**Multi-model open-core intelligent coding terminal** — AI-assisted code generation, security auditing, MCP protocol integration, and extensible skills system in a single CLI.

Built by [One Mipham Corporation](https://onemipham.com) (北京华安麦逄科技有限公司) | Brand: MiphamAI

## Quick Install

```bash
npm install -g @miphamai/cli
mipham
```

Or via curl:

```bash
# International
curl -fsSL https://mipham.ai/install.sh | bash

# China mainland
curl -fsSL https://onemipham.com/install.sh | bash
```

Requirements: **Bun 1.2+** (recommended) or **Node.js 22+**

## Features

- **7 AI Providers** — Anthropic Claude · OpenAI GPT · DeepSeek · Google Gemini · Doubao 豆包 · Tencent Hunyuan 混元 · Qwen 通义千问
- **16 Built-in Tools** — File ops, shell execution, agent dispatch, MCP integration, web search
- **60 Slash Commands** — Claude Code-compatible, zero re-learning
- **14 Skills** — 12 standard + 2 Mipham-exclusive, dual-runtime architecture
- **MCP Protocol** — Full JSON-RPC 2.0 stdio transport for external server integration
- **Security Hardened** — Path sandbox · SSRF protection · Bash blacklist · Permission gating · Parameter validation
- **Session Persistence** — Auto-save/restore across CLI restarts
- **Cross-Platform** — macOS · Linux · Windows

## Quick Start

```bash
mipham

# Set API keys
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."

# Switch model
/switch deepseek deepseek-v4-pro

# Show commands
/help
```

## Commands

| Category | Commands                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------- |
| Session  | `/help` `/clear` `/compact` `/context` `/status` `/rename` `/goal` `/recap` `/export` `/doctor` `/resume` |
| Model    | `/pick` `/model` `/models` `/provider` `/providers` `/switch` `/fast` `/effort`                           |
| Tools    | `/tools` `/skills` `/reload-skills` `/mcp`                                                                |
| Workflow | `/plan` `/review` `/diff` `/todos` `/tasks` `/workflows`                                                  |
| Security | `/security` `/audit` `/permissions` `/add-dir`                                                            |
| Setup    | `/setup` `/init` `/config` `/theme` `/ide` `/terminal-setup`                                              |

Press **Ctrl+P** for interactive model picker · **Shift+Tab** to cycle permission mode

## Documentation

- [Product Specification](https://github.com/One-Mipham/mipham-code/blob/main/PRODUCT.md)
- [Install Guide](https://mipham.ai/code/install) (International)
- [国内站](https://onemipham.com/mipham-code) (China mainland)
- [GitHub](https://github.com/One-Mipham/mipham-code)
- [Issues & Feedback](https://github.com/One-Mipham/mipham-code/issues)

## License

Apache 2.0 — Open Core
