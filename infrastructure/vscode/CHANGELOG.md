# Mipham Code — VS Code Extension Changelog

> Entries for 0.75.0–0.81.2 were backfilled on 2026-09-14 from the root `CHANGELOG.md`
> (tag dates). The extension is a thin launcher, so CLI-facing changes are listed here too.

## 0.82.0 — 2026-09-20

- Version sync with Mipham Code CLI 0.82.0
- Public copy counts realigned with their sources: AI providers 7 → 12, tools 30 → 31
- New guard for the total tool count, scanning by _carrier_ rather than only `.md`
  (a bare `.md`-only sweep left `package.json`'s `description` permanently green)

## 0.81.9 — 2026-09-19

- Version sync with Mipham Code CLI 0.81.9
- Security: `Bash(...)` allow rules were granted when **any** segment of a compound
  command matched, so `Bash(git:*)` authorised `git status && rm -rf ./src` without
  a prompt; allow rules now require **every** segment to match
- Security: the invisible-Unicode strip set was written as 16 literal characters
  (unreviewable in a diff) and was missing the tag block, which can hide arbitrary
  text inside a command; rewritten as escapes, set completed, boundaries pinned
- Fixed: an empty `tool_result.content` is rejected by the API and takes the **whole
  request — history included** — with it, so one empty block made a conversation
  permanently unsendable
- Fixed: project rules were silently dead in worktree sessions — `.mipham/` is
  gitignored and worktrees live under `.mipham/worktrees/`, so the real checkout
  never had that directory
- Fixed: `/upgrade` reported "already up to date" when the registry was unreachable;
  "never asked" and "asked, you are current" were the same value
- Fixed: three state files accepted any valid JSON regardless of shape, so `{}` /
  `null` / `123` took down whole commands; reads now validate shape at the entry
  point, and the writes are atomic
- Fixed: `/bg` and `/mcp disconnect` both reported success for work they had not
  done (prompt never reached the model; tools stayed callable)

## 0.81.8 — 2026-09-18

- Version sync with Mipham Code CLI 0.81.8
- Security: `Bash(...)` deny rules could be walked around by putting shell noise in
  front of the base command (`( rm -rf x )`, `FOO=bar rm -rf x`, `! rm -rf x`,
  `for f in *; do rm -rf x; done`) — the matcher never saw the real command. Four
  more of that family went with it: `timeout --preserve-status cat secret`, process
  substitution, `~` / `$HOME` expansion, and a worktree-escape guard that compared
  path strings instead of resolving them
- Security: installing a plugin from npm no longer runs the package's install
  scripts — `npm install --no-save` was missing `--ignore-scripts`, so any
  `postinstall` ran with the user's full privileges
- Fixed: `/resume` no longer loses the whole session list to a single unreadable
  file; `Read`'s advertised `offset`/`limit` now avoid reading the whole file
  instead of erroring on it; `preferences.json` / `keys.json` / `config.yml` are
  written atomically rather than truncated in place
- Added: a Harbor benchmark adapter under `benchmarks/` (development tooling — it
  ships nothing into the CLI). The two rounds recorded there are instrument checks,
  not scores

## 0.81.7 — 2026-09-17

- Version sync with Mipham Code CLI 0.81.7
- Fixed: `mipham daemon start` could not start the daemon from the compiled binary — the
  self-spawn assumed the source-mode argv, so `bun` was absent from PATH and the `$bunfs`
  entry point was unreadable by the newly spawned interpreter. The daemon now re-execs
  itself (`process.execPath`), and the argv discriminator asks one question: is the
  interpreter in `argv[0]`. Startup failures report a non-zero exit code plus stderr
  instead of printing a `Daemon started` that never happened, and `daemon restart` waits
  for the old daemon to actually exit rather than reporting the old pid as the new one

## 0.81.6 — 2026-09-15

- Version sync with Mipham Code CLI 0.81.6
- Security: `Read(...)` deny rules missed a whole class of commands that read a file and
  write to stdout (`fmt secret`, `column -t secret`), so a denied file still reached the
  Bash tool's read path — 20 readers added, none of them treated as writers
- Security: `/clear` and `/resume` left the session's read-before-write record intact, so a
  fresh conversation could overwrite a file it had never read. The record is now dropped
  whenever the message history is replaced
- Fixed: a burst of MCP `tools/list_changed` notifications each triggered their own
  `tools/list` round trip plus a full downstream re-registration — sustained CPU and a
  re-registration storm. Refreshes are now coalesced per connection (250 ms debounce with a
  2000 ms ceiling), and the pending timer is cleared on disconnect / reconnect

## 0.81.5 — 2026-09-14

- Version sync with Mipham Code CLI 0.81.5 (product line skips 0.81.4, which this
  extension consumed for a changelog-only republish)
- Security: the daemon's external API now validates `Origin` and the session `cwd` — a web
  page in the user's own browser could previously drive the agent into reading any file
  under a directory of its choosing
- Built-in `superpower` skill 2.1.0 — lifted the `<SUBAGENT-STOP>` guard, the announce
  convention, and the expanded Red Flags table from upstream; fixed four skill names it
  referenced that do not exist in Mipham Code

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
