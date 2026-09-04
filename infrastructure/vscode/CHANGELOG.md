# Mipham Code — VS Code Extension Changelog

## 0.74.0 — 2026-09-04

- Version sync with Mipham Code CLI 0.74.0
- Fixed chat input paste reordering / content loss / freeze (replaced ink-text-input with a ref-based atomic-append input)
- CRSI eval harness: added self-report-diagnostic anchor (no LLM in the scoring path)

## 0.44.0 — 2026-08-17

- Version sync with Mipham Code CLI 0.44.0
- Updated tool count to 30 tools (matching the CLI)

## 0.10.0 — 2026-08-05

- Initial VS Code extension release
- Integrated terminal launch with Mipham Code CLI
- Status bar item showing Mipham Code status
- Quick launch: `Cmd+Esc` (macOS) / `Ctrl+Esc` (Windows/Linux)
- Focus terminal: `Cmd+Shift+M` / `Ctrl+Shift+M`
- Open Config command for quick access to `.mipham/config.yml`
- Auto-detection of Bun runtime path
- Auto-detection of Mipham Code installation (global npm, local monorepo, PATH)
- Provider and model configuration via VS Code settings
- File context sharing: `MIPHAM_IDE=vscode` environment variable
- Welcome message on first activation
- Apache 2.0 license
