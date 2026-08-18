# Mipham Code — VS Code Extension

Multi-model AI coding terminal integrated into VS Code. 30 tools, 7 AI providers, background agents, plan mode, workflow orchestration — now inside your editor.

## Features

- **Integrated Terminal** — `Cmd+Esc` launches Mipham Code in the VS Code terminal
- **Status Bar** — Shows active provider/model, click to focus terminal
- **Quick Config** — "Mipham Code: Open Config" opens your `.mipham/config.yml`
- **File Context** — `MIPHAM_IDE=vscode` env var for workspace-aware AI
- **Keybindings** — `Cmd+Esc` (start), `Cmd+Shift+M` (focus terminal)
- **Auto-Detection** — Finds Bun runtime and Mipham Code installation automatically

## Prerequisites

- [Bun](https://bun.sh) runtime (auto-detected from Homebrew, PATH, or `~/.bun/bin/`)
- Mipham Code CLI installed: `npm install -g @miphamai/cli`
- Or: `curl -fsSL https://mipham.ai/install.sh | bash`

## Installation

### From VS Code Marketplace

Search "Mipham Code" in the Extensions view (`Cmd+Shift+X`), or install from the
[Marketplace page](https://marketplace.visualstudio.com/items?itemName=miphamai.mipham-code).

### From VSIX (local)

```bash
cd infrastructure/vscode
npx vsce package
code --install-extension mipham-code-0.47.0.vsix
```

### Development (symlink)

```bash
ln -s $(pwd)/infrastructure/vscode ~/.vscode/extensions/miphamai.mipham-code
```

## Configuration

In VS Code `settings.json`:

```json
{
  "mipham-code.provider": "deepseek",
  "mipham-code.model": "deepseek-v4-pro",
  "mipham-code.bunPath": "/opt/homebrew/bin/bun"
}
```

All settings are optional — Mipham Code auto-detects everything.

| Setting                | Type   | Default | Description         |
| ---------------------- | ------ | ------- | ------------------- |
| `mipham-code.bunPath`  | string | auto    | Path to bun runtime |
| `mipham-code.provider` | string | `""`    | Default provider ID |
| `mipham-code.model`    | string | `""`    | Default model ID    |

## Commands

| Command                         | Shortcut                       | Description                    |
| ------------------------------- | ------------------------------ | ------------------------------ |
| **Mipham Code: Start**          | `Cmd+Esc` / `Ctrl+Esc`         | Open terminal with Mipham Code |
| **Mipham Code: Focus Terminal** | `Cmd+Shift+M` / `Ctrl+Shift+M` | Focus existing terminal        |
| **Mipham Code: Open Config**    | —                              | Open `.mipham/config.yml`      |

## Supported Providers

Anthropic · OpenAI · DeepSeek · Qwen · ByteDance Doubao · Tencent Hunyuan · MiphamAI

## License

Apache 2.0 — [Repository](https://github.com/One-Mipham/mipham-code)
