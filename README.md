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
- **31 Built-in Tools**: File ops, shell commands, git, web search, MCP protocol, agents
- **Skills System**: 28 built-in skills (22 standard + 6 Mipham exclusive) + marketplace
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
npm install -g @miphamai/cli
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
# → 0.2.2
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
mipham --provider openai --model gpt-5.4
```

## Architecture

```
pnpm monorepo
├── packages/shared/     # @mipham/shared — types and constants
├── apps/cli/            # @miphamai/cli — Bun + Ink CLI
│   ├── src/core/        # Engine, context, permission, hooks, instructions
│   ├── src/providers/   # Anthropic, OpenAI-compat, provider registry
│   ├── src/tools/       # 31 tools: file, exec, agent, network, system, scheduling, artifact, computer
│   ├── src/skills/      # Skills loader + marketplace
│   ├── src/mcp/         # MCP stdio client
│   └── src/ui/          # React/Ink chat UI
└── apps/web/            # @mipham/web — Next.js product page
```

## Commands

| Command                      | Description                                                |
| ---------------------------- | ---------------------------------------------------------- |
| `Ctrl+P` or `/pick`          | **Interactive model picker** (two-level: provider → model) |
| `/help`                      | Show all available commands (40+)                          |
| `/model`                     | Show current model                                         |
| `/models`                    | List available models                                      |
| `/providers`                 | List configured providers                                  |
| `/switch <provider> <model>` | Switch provider and model                                  |
| `/clear`                     | Clear conversation history                                 |
| `/exit`                      | Exit Mipham Code                                           |

## Configuration

Create `~/.mipham/config.yml`:

```yaml
version: '0.2.0'
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
permission: auto
```

Or project-level `.mipham/config.yml` in your repository.

## Supported Models

| Provider        | Models                                                        | Context    | Status   |
| --------------- | ------------------------------------------------------------- | ---------- | -------- |
| Anthropic       | Claude Mythos 5, Fable 5, Opus 5/4.8, Sonnet 5/4.6, Haiku 4.5 | 200K–1M    | Active   |
| OpenAI          | GPT-6 Astra, GPT-5.5, GPT-5.4, GPT-5.4 Mini                   | 400K–1.05M | Active   |
| Google Gemini   | Gemini 3.0 Pro, 3.0 Flash, 2.5 Pro                            | 128K–2M    | Active   |
| DeepSeek        | V4 Pro, V4 Flash                                              | 1M         | Active   |
| 豆包 (字节跳动) | Seed 2.0 Pro/Code/Lite/Mini, Seed 1.6/Flash                   | 256K       | Active   |
| 腾讯混元        | Hy3 Preview, 2.0 Think/Instruct, TurboS, T1, A13B, Lite       | 32K–256K   | Active   |
| 通义千问        | Qwen Plus, Qwen Max                                           | 128K       | Active   |
| Kimi (月之暗面) | K3, Latest, Moonshot v1 8K/32K/128K                           | 8K–1M      | Active   |
| MiniMax         | M2.7, M2, Text 01（国内 / 国际）                              | 200K–1M    | Active   |
| MiphamAI        | OM V5 Pro, OM V5 Flash, OM V5 Visual                          | 200K–1M    | Upcoming |

**共 10 家提供商，45+ 模型。** 设置 API Key 即可使用：

```bash
export ANTHROPIC_API_KEY="sk-ant-..."      # Anthropic Claude
export OPENAI_API_KEY="sk-proj-..."        # OpenAI GPT
export GEMINI_API_KEY="..."                # Google Gemini
export DEEPSEEK_API_KEY="sk-..."           # DeepSeek
export DOUBAO_API_KEY="..."                # 豆包 (火山引擎)
export HUNYUAN_API_KEY="..."               # 腾讯混元
export QWEN_API_KEY="sk-..."               # 通义千问 (阿里云)
export KIMI_API_KEY="sk-..."               # Kimi (月之暗面)
export MINIMAX_API_KEY="..."               # MiniMax (国内)
export MINIMAX_GLOBAL_API_KEY="..."        # MiniMax (国际)
```

## Development

```bash
git clone https://github.com/One-Mipham/mipham-code.git
cd mipham-code
pnpm install
pnpm dev:cli    # Start CLI in development mode
pnpm dev:web    # Start web frontend
pnpm typecheck  # Run type checking
pnpm lint       # Run linting
pnpm test       # Run tests
```

## 基准（仪器验通，不作为成绩）

本节的两个数是**把跑分仪器验通**的读数，**不是成绩** —— 我们不拿它们对外引用。理由可核，不是谦辞：

- **题量**：两轮各跑 10 题，而 `terminal-bench@2.0` 的题库是 **89** 题、`swebench-verified@1.0` 是 **500** 题 ⇒ 样本是 11% 与 2%；且**不是随机抽样**（前者取字典序前 10，后者取前 10 个仓库各自的第 1 题）。
- **未固定 seed**：两轮的记录里都没有 seed 字段 ⇒ 这一轮不可复现。
- **`k=1`**：每题只跑一次，分不出「能干」与「完美」—— 下面 9/10 的 95% Wilson 区间宽到 `[0.60, 0.98]`。
- **跑在 x86 模拟下**：宿主 arm64、镜像全是 `linux/amd64` ⇒ 墙钟时间受影响；Phase 1 的 4 题超时里有 3 题是编译型任务，**「超时是平台惩罚还是模型不行」尚未归因**。

读数如下（**两个数必须成对读**：只报「完成题数」会显得比实际好，只报「官方分数」会显得比实际差）：

| 轮次    | 数据集                                                  | 跑到 agent 结果 | harbor 报的分数                                                                   | tokens                          |
| ------- | ------------------------------------------------------- | --------------: | --------------------------------------------------------------------------------- | ------------------------------- |
| Phase 1 | `terminal-bench@2.0`（10 题，`k=1`）                    |          8 / 10 | `Mean: 0.000`（8 题 reward 全 0.0）                                               | 7,973,562 = 50.5M 上限的 15.79% |
| Phase 2 | `swebench-verified@1.0`（10 题 / 10 个不同仓库，`k=1`） |          9 / 10 | `Mean: 0.900`（9 题 reward 全 1.0；分母 10 含 1 个网络故障的 trial，按 0 分并入） | 21,564,338                      |

- **结果文件**: [`benchmarks/results/phase1-terminal-bench.json`](./benchmarks/results/phase1-terminal-bench.json)、[`benchmarks/results/phase2-swebench-verified.json`](./benchmarks/results/phase2-swebench-verified.json)
- **复现**: 见 [`benchmarks/README.md`](./benchmarks/README.md) 的跑分一节 —— `DOCKER_DEFAULT_PLATFORM=linux/amd64`、数据集下载与三个台账变量**都不可省**（不带的实测代价有先例：40.4 秒、`n_trials: 0`），故不在此处复制成一行。
- **完整披露**: [`benchmarks/README.md`](./benchmarks/README.md) —— 五条强制披露、选题规则、规格分歧与已知限制的全文都在那里，此处不复制。

## License

Apache 2.0 — see [LICENSE](./LICENSE)

## Links

- **Website**: [mipham.ai/code](https://mipham.ai/code)
- **Documentation**: [mipham.ai/code/docs](https://mipham.ai/code/docs)
- **GitHub**: [github.com/One-Mipham/mipham-code](https://github.com/One-Mipham/mipham-code)
- **Telemetry & privacy**: [docs/telemetry.md](./docs/telemetry.md) — off by default; the full data dictionary
