# Mipham Code — VS Code Extension Changelog

> Entries for 0.75.0–0.81.2 were backfilled on 2026-09-14 from the root `CHANGELOG.md`
> (tag dates). The extension is a thin launcher, so CLI-facing changes are listed here too.

## 0.81.4 — 2026-09-14

- Changelog-only republish: adds the 0.75.0–0.81.2 entries that had gone missing.
  No extension code change; still runs Mipham Code CLI 0.81.3.

## 0.81.3 — 2026-09-14

- Version sync with Mipham Code CLI 0.81.3
- Fixed: `.mipham/rules/*.md` path-scoped rules were never injected — the loader is now wired
  at startup and after both the first tool round and the multi-turn tool loop

## 0.81.2 — 2026-09-14

- Version sync with Mipham Code CLI 0.81.2
- Fixed: first-run wizard no longer overwrites built-in model metadata; `doctor` audit and
  `deploy status` output fixes

## 0.81.1 — 2026-09-13

- Version sync with Mipham Code CLI 0.81.1
- Fixed: session logs written to the wrong location when `$HOME` differs from the real home
  directory

## 0.81.0 — 2026-09-12

- Version sync with Mipham Code CLI 0.81.0
- Security: prefix commands (`sudo`, `env`, `xargs`, …) no longer bypass Read / Edit / Bash
  deny rules
- Configurable workflow concurrency limit (`MIPHAM_WORKFLOW_MAX_CONCURRENT_AGENTS`)

## 0.80.1 — 2026-09-12

- Version sync with Mipham Code CLI 0.80.1
- Fixed intermittent duplicated banner on the welcome screen

## 0.80.0 — 2026-09-12

- Version sync with Mipham Code CLI 0.80.0
- Upgraded Ink 5 → 7 and React 18 → 19

## 0.79.1 — 2026-09-11

- Version sync with Mipham Code CLI 0.79.1
- Fixed macOS Backspace regression (Ink maps `\x7f` to `delete`, not `backspace`)

## 0.79.0 — 2026-09-11

- Version sync with Mipham Code CLI 0.79.0
- Left/right cursor movement in the chat input; status-line and `/help` display fixes
- npm releases moved to OIDC trusted publishing

## 0.78.0 — 2026-09-11

- Version sync with Mipham Code CLI 0.78.0
- New skill `trim-process-prose`; renamed `systematic-debugging` → `debug-loop`; removed
  `pre-push-checks`

## 0.77.2 — 2026-09-10

- Version sync with Mipham Code CLI 0.77.2
- Security: marketplace skill names are now sanitized before being used in a path
  (path-traversal fix)
- Bash tool description guidance

## 0.77.1 — 2026-09-09

- Version sync with Mipham Code CLI 0.77.1
- Security: upgraded vulnerable dependencies (next, sharp, js-yaml)

## 0.77.0 — 2026-09-09

- Version sync with Mipham Code CLI 0.77.0
- Untrusted-content rule: output read from artifacts / MCP / the web is treated as data,
  never as instructions

## 0.76.0 — 2026-09-07

- Version sync with Mipham Code CLI 0.76.0
- New providers: MiniMax (domestic / global), GPT-6 Astra, Claude Mythos 5
- `skills.reminder` startup-token toggle (full / compact / off)
- Security: recursive `$()` / backtick substitution no longer bypasses Bash deny rules

## 0.75.0 — 2026-09-05

- Version sync with Mipham Code CLI 0.75.0
- `/skill-doctor` — unused-skill report with context cost
- PR indicator in the status bar

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
