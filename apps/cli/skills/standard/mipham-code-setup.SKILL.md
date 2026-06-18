---
name: mipham-code-setup
description: Guide for installing, configuring, and troubleshooting Mipham Code — the multi-model open-core intelligent coding terminal
version: 1.0.0
---

# Mipham Code Setup

Comprehensive setup and configuration guide for Mipham Code.

## Installation

**Quick install (recommended):**

```bash
curl -fsSL https://mipham.ai/install.sh | bash
```

**npm global install:**

```bash
npm install -g @miphamai/cli
mipham
```

**From source:**

```bash
git clone https://github.com/One-Mipham/mipham-code
cd mipham-code/apps/cli
bun install && bun run bin/mipham
```

## Configuration

### 1. Create project config

Run `/setup` in Mipham Code for a guided 6-step wizard, or manually:

```bash
mkdir -p .mipham
```

`.mipham/config.yml`:

```yaml
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
permission: auto
```

### 2. Set API Keys

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export DEEPSEEK_API_KEY="sk-..."
export QWEN_API_KEY="sk-..."
export DOUBAO_API_KEY="..."
export HUNYUAN_API_KEY="..."
export GEMINI_API_KEY="..."
```

Or add to `~/.mipham/config.yml`:

```yaml
providers:
  - id: anthropic
    apiKey: $ANTHROPIC_API_KEY
```

### 3. Project personality (MIPHAM.md)

Create `MIPHAM.md` in project root to define AI interaction style:

- Code preferences
- Language (zh-CN / en)
- Project-specific rules

### 4. Verify installation

```bash
mipham --version
mipham --help
```

Use `/doctor` in Mipham Code for system diagnostics.

## Supported Providers

| Provider      | Type          | Models                                 |
| ------------- | ------------- | -------------------------------------- |
| Anthropic     | Native SDK    | Claude Haiku 4.5, Sonnet 4.6, Opus 4.8 |
| OpenAI        | OpenAI Compat | GPT-5.4 Mini, GPT-5.4, GPT-5.5, Codex  |
| DeepSeek      | OpenAI Compat | V4 Flash, V4 Pro                       |
| Google Gemini | OpenAI Compat | 3.0 Flash/Pro, 2.5 Pro                 |
| Qwen          | OpenAI Compat | Qwen Plus, Qwen Max                    |
| Doubao        | OpenAI Compat | Seed 1.6/2.0 series                    |
| Hunyuan       | OpenAI Compat | Lite, TurboS, 2.0, T1                  |

## Slash Commands (60 total)

Essential: `/help`, `/switch`, `/model`, `/setup`, `/doctor`, `/mcp`
Workflow: `/plan`, `/review`, `/diff`, `/todos`, `/tasks`
Session: `/clear`, `/compact`, `/rename`, `/goal`, `/export`, `/resume`

## Troubleshooting

- **"Provider not registered"**: Check API key is set (`env | grep API_KEY`)
- **"Model not found"**: Use `/models` to list available models
- **Slow responses**: Toggle `/fast on` or switch to a Flash model
- **Context full**: Use `/compact` to free token space
- **Permission denied**: Use `/permissions` to check tool access settings
