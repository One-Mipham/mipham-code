# Mipham Code — VS Code Extension

Multi-model AI coding terminal integrated into VS Code.

## Features

- **Integrated Terminal** — Cmd+Esc launches Mipham Code in the VS Code terminal
- **Status Bar** — Shows active provider/model, click to focus terminal
- **Config Command** — "Mipham Code: Open Config" opens your config file
- **Keybindings** — Cmd+Esc (start), Cmd+Shift+M (focus)

## Installation

### From local monorepo

```bash
# Symlink into VS Code extensions
ln -s $(pwd)/infrastructure/vscode ~/.vscode/extensions/miphamai.mipham-code

# Or package and install
cd infrastructure/vscode
npx vsce package
code --install-extension mipham-code-0.10.0.vsix
```

### Prerequisites

- [Bun](https://bun.sh) runtime (auto-detected)
- Mipham Code installed globally: `npm install -g @miphamai/cli`

## Configuration

In VS Code `settings.json`:

```json
{
  "mipham-code.provider": "deepseek",
  "mipham-code.model": "deepseek-v4-pro",
  "mipham-code.bunPath": "/opt/homebrew/bin/bun"
}
```

## Commands

| Command                     | Shortcut    | Description                    |
| --------------------------- | ----------- | ------------------------------ |
| Mipham Code: Start          | Cmd+Esc     | Open terminal with Mipham Code |
| Mipham Code: Focus Terminal | Cmd+Shift+M | Focus existing terminal        |
| Mipham Code: Open Config    | —           | Open config file               |
