# ✦ Mipham Code

> **Multi-model open-core intelligent coding terminal**
>
> MiphamAI | One Mipham Corporation | [mipham.ai](https://mipham.ai/code)

<p align="center">
  <img src="apps/cli/assets/icon.jpg" alt="Mipham Code" width="128" />
</p>

Mipham Code is an open-core, multi-model intelligent coding terminal built with Bun + React/Ink for CLI and Next.js for web. It supports Anthropic Claude, OpenAI GPT, DeepSeek, Qwen, and MiphamAI models through a unified interface with SSE streaming, tool execution, and an extensible skills system.

## Features

- **Multi-Model**: Connect to Claude, GPT, DeepSeek, Qwen, and MiphamAI models
- **Open-Core**: Apache 2.0 licensed — free and open-source
- **16 Built-in Tools**: File ops, shell commands, git, web search, MCP protocol, agents
- **Skills System**: 10 built-in skills + dual-track runtime (standard / Mipham exclusive)
- **Streaming**: Real-time SSE streaming with tool use support
- **Fast**: Built on Bun runtime, sub-millisecond tool execution

## Quick Start

### Prerequisites
- **Bun 1.2+** (recommended) or Node.js 22+
- macOS, Linux, or WSL2

### Install

**方式一：官方一键安装脚本（推荐）**

```bash
curl -fsSL https://mipham.ai/install.sh | bash
```

**方式二：npm 全局安装**

```bash
npm install -g @mipham/cli
```

**方式三：Homebrew（仅 macOS）**

```bash
brew install mipham
```

> 注意：Homebrew formula 正在审核中。目前建议使用方式一或方式二安装。
> 公式文件：`infrastructure/brew/mipham.rb`

### 验证安装

```bash
mipham --version
# → 0.1.0
```

### Run

```bash
# 启动 Claude Sonnet
export ANTHROPIC_API_KEY="sk-ant-..."
mipham --model claude-sonnet-4-6

# 启动 DeepSeek
export DEEPSEEK_API_KEY="sk-..."
mipham --provider deepseek --model deepseek-v4-pro

# 启动 OpenAI
export OPENAI_API_KEY="sk-proj-..."
mipham --provider openai --model gpt-5.3-codex
```

## Architecture

```
pnpm monorepo
├── packages/shared/     # @mipham/shared — types and constants
├── apps/cli/            # @mipham/cli — Bun + Ink CLI
│   ├── src/core/        # Engine, context, permission, hooks, instructions
│   ├── src/providers/   # Anthropic, OpenAI-compat, provider registry
│   ├── src/tools/       # 16 tools: file, exec, agent, network, system
│   ├── src/skills/      # Skills loader + standard/mipham runtimes
│   ├── src/mcp/         # MCP stdio client
│   └── src/ui/          # React/Ink chat UI
└── apps/web/            # @mipham/web — Next.js product page
```

## Commands

| Command | Description |
|---------|-------------|
| `Ctrl+P` or `/pick` | **Interactive model picker** (two-level: provider → model) |
| `/help` | Show all available commands (40+) |
| `/model` | Show current model |
| `/models` | List available models |
| `/providers` | List configured providers |
| `/switch <provider> <model>` | Switch provider and model |
| `/clear` | Clear conversation history |
| `/exit` | Exit Mipham Code |

## Configuration

Create `~/.mipham/config.yml`:

```yaml
version: "0.1.0"
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
permission: auto
```

Or project-level `.mipham/config.yml` in your repository.

## Supported Models

| Provider | Models | Context | Status |
|----------|--------|---------|--------|
| Anthropic | Claude Opus 4.8, Sonnet 4.6, Haiku 4.5 | 200K–1M | Active |
| OpenAI | GPT-5.5, GPT-5.4, GPT-5.4 Mini, GPT-5.3 Codex | 400K–1.05M | Active |
| DeepSeek | V4 Pro, V4 Flash | 1M | Active |
| 豆包 (字节跳动) | Seed 2.0 Pro/Code/Lite/Mini, Seed 1.6/Flash | 256K | Active |
| 腾讯混元 | Hy3 Preview, 2.0 Think/Instruct, TurboS, T1, A13B, Lite | 32K–256K | Active |
| 通义千问 | Qwen Plus, Qwen Max | 128K | Active |
| MiphamAI | OM V5 Pro, OM V5 Flash, OM V5 Image | 200K–1M | Upcoming |

**共 7 家提供商，40+ 模型。** 设置 API Key 即可使用：

```bash
export ANTHROPIC_API_KEY="sk-ant-..."      # Anthropic Claude
export OPENAI_API_KEY="sk-proj-..."        # OpenAI GPT
export DEEPSEEK_API_KEY="sk-..."           # DeepSeek
export DOUBAO_API_KEY="..."                # 豆包 (火山引擎)
export HUNYUAN_API_KEY="..."               # 腾讯混元
export QWEN_API_KEY="sk-..."               # 通义千问 (阿里云)
```

## Development

```bash
git clone https://github.com/mipham-ai/mipham-code.git
cd omc-project9-MiphamCode
pnpm install
pnpm dev:cli    # Start CLI in development mode
pnpm dev:web    # Start web frontend
pnpm typecheck  # Run type checking
pnpm lint       # Run linting
pnpm test       # Run tests
```

## License

Apache 2.0 — see [LICENSE](./LICENSE)

## Links

- **Website**: [mipham.ai/code](https://mipham.ai/code)
- **Documentation**: [mipham.ai/code/docs](https://mipham.ai/code/docs)
- **GitHub**: [github.com/mipham-ai/mipham-code](https://github.com/mipham-ai/mipham-code)
