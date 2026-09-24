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

> ⚠️ **从 0.85.0 及更早版本升级：请先别用 `mipham update`**
>
> 0.84.0 及更早版本给安装步骤挂了 **10 分钟超时**，而这个包有 84 MB / 6,601 个文件 ——
> 慢网络（国内直连 npm 常常超过 10 分钟）下，计时器会在安装**中途**杀掉 npm，留下
> 「旧版本已删、新版本没写完」：机器上**连一个 `mipham` 都没有**，连你用来重试的
> `mipham update` 也一起没了。`/upgrade` 同理。
>
> 请改用下面方式一或方式二升级 —— 由 npm 直接在你的终端里执行，**不设超时**，装得再慢也不会被砍。
> 升到 **0.85.1** 后 `mipham update` 可以正常使用：不再带超时；装前快照、装后实跑 launcher 自证、
> 失败自动回滚；安装窗口内按 Ctrl-C 也不会再打断安装（**该窗口内 Ctrl-C 会被忽略**，要中断请另开
> 一个终端杀进程）。

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
# → @miphamai/cli v0.85.4
```

### Run

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # 至少配一家 provider 的 key
mipham                                  # 启动用的是 config.yml 里的 defaultProvider / defaultModel
```

```bash
mipham
# 启动后按 Ctrl+P（或输入 /pick）—— 两级选择器：provider → model
# 也可直接 /switch <provider> <model>，例如 /switch deepseek deepseek-v4-pro
```

> `mipham` 本身**不解析** `--model` / `--provider`。入口只认这五个 flag：
> `--version`（`-v`/`-V`）/ `--help`（`-h`）/ `--dump-config` / `--safe-mode` / `--resume`。
> 选模型走上面的两条路，落盘位置与默认值见下节 **Configuration**。

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
| `/help`                      | Show all available commands (137)                          |
| `/model`                     | Show current model                                         |
| `/models`                    | List available models                                      |
| `/providers`                 | List configured providers                                  |
| `/switch <provider> <model>` | Switch provider and model                                  |
| `/clear`                     | Clear conversation history                                 |
| `/exit`                      | Exit Mipham Code                                           |

## Configuration

Create `~/.mipham/config.yml`:

```yaml
version: '0.83.0'
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
permission: default
```

Or project-level `.mipham/config.yml` in your repository.

> `permission` 取五个档位之一：`default`（默认）/ `acceptEdits` / `plan` / `auto` / `bypassPermissions`。
> ⚠️ **`auto` 不是「让工具自行决定」** —— 那是它 3 档时代的旧义；现在指的是「由分类器自动放行」。
> 同名不同义，别照旧文档抄。

## Supported Models

| Provider        | Models                                                                | Context    | Status |
| --------------- | --------------------------------------------------------------------- | ---------- | ------ |
| Anthropic       | Claude Mythos 5, Fable 5/5.1, Opus 5/5.5/4.8, Sonnet 5/4.6, Haiku 4.5 | 200K–1M    | Active |
| OpenAI          | GPT-6 Astra, GPT-5.5, GPT-5.4, GPT-5.4 Mini, GPT-5.3 Codex            | 400K–1.05M | Active |
| Google Gemini   | Gemini 3.0 Pro, 3.0 Flash, 2.5 Pro                                    | 1M         | Active |
| DeepSeek        | V4 Pro, V4 Flash                                                      | 1M         | Active |
| 豆包 (字节跳动) | Seed 2.0 Pro/Code/Lite/Mini, Seed 1.6/Flash                           | 256K       | Active |
| 腾讯混元        | Hy3 Preview, 2.0 Think/Instruct, TurboS, T1, A13B, Lite               | 32K–256K   | Active |
| 通义千问        | Qwen Plus, Qwen Max                                                   | 128K       | Active |
| Kimi (月之暗面) | K3, Latest, Moonshot v1 8K/32K/128K                                   | 8K–1M      | Active |
| MiniMax (国内)  | M2.7, M2, Text 01                                                     | 200K–1M    | Active |
| MiniMax (国际)  | M2.7, M2, Text 01                                                     | 200K–1M    | Active |
| MiphamAI        | OM V5 Flash/Visual/Pro/Apex                                           | 16K–200K   | Active |
| Ollama (本地)   | 本机已装模型（`ollama list` 动态发现）                                | —          | Active |

**共 12 家提供商，50 个模型。** 设置 API Key 即可使用：

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
export MIPHAM_API_KEY="..."                # MiphamAI (官方模型)
```

> Ollama 不需要 key —— 走本机 `http://localhost:11434/v1`，模型列表动态发现。

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
