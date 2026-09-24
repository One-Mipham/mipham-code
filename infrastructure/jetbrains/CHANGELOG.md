# Mipham Code — JetBrains Plugin Changelog

> Entries for 0.84.0–0.85.4 were backfilled on 2026-09-24 from the root `CHANGELOG.md`
> (tag dates) and use the same wording as the VS Code extension's changelog — the plugin is a
> thin launcher, so CLI-facing changes are listed here too.

## 0.85.4 (2026-09-24)

- Version sync with Mipham Code CLI 0.85.4
- Fixed: `/permissions` refused the very spelling it told you to type. The denial message prints
  `/permissions allow "Bash"`, but typing `allow "Git"` returned
  `Invalid rule ""Git"": not a single tool name.` — `positional[1]` was taken as the rule verbatim,
  quotes and all, while every place that prints it prints the quoted form; and in
  `allow "Git" "Bash"` the second rule was never read at all, so it was dropped silently. Every
  rule after the verb is now re-split on quotes, validated, and persisted. A meta-test pulls the
  exact command out of the real denial text and runs it, so the copy and the command cannot drift
  apart
- Fixed: the auto-mode classifier shared its output budget with the model's own thinking. The
  request was pinned to `maxTokens: 200`, and a real model (`deepseek-v4-pro`, three live calls)
  burned through it in ~880 characters of reasoning: `finish_reason=length`, visible text empty in
  3 of 3 calls, all three then refused as "unreadable" — the calls that most needed a ruling were
  the ones guaranteed to starve. `chunk.truncated` was never read either, so "cut off at the cap"
  and "answered unintelligibly" looked identical. The cap is gone (the provider default applies
  now), and truncated is read and named in the reason

## 0.85.3 (2026-09-23)

- Version sync with Mipham Code CLI 0.85.3
- Added: `--permission <mode>`. The option existed all along (`RunOptions.permission`) but no call
  site ever passed it, so non-interactive runs could only pick a mode through the daemon-only
  `MIPHAM_DAEMON_PERMISSION`. `mipham --permission plan` now starts in `plan`
- Added: `permissions.defaultMode` in `settings.json` is now a door for the mode. The rule is one
  sentence: **only the operator's own files move the ceiling.** `--permission` beats user-level
  `settings.json`, which beats user-level `config.yml`, which beats the built-in `default`.
  Project-level `.mipham/config.yml` and `.mipham/settings.json` are **not doors at all** — they
  arrive with the code, and cloning a repository is not consenting to the mode it ships. Setting
  one there is refused, and the value and path are named on stderr
- Fixed: the permission block in the system prompt was frozen at startup. It was built once from
  the mode in hand and nothing rebuilt it, so after Shift+Tab the gate allowed more while the
  model still held the older instruction — it would refuse work it was now allowed to do. It is
  now derived at read time, with the seam in the context layer, which is what keeps the change
  from reaching sessions that set no system prompt at all
- Fixed: a subagent never knew which mode it was in. Its prompt is assembled from the agent
  definition and carried no permission block. It now reports **its own** mode — read from the
  gate's result, not from the definition, which the org-level ceiling can silently clamp — and it
  lands on the prompt that is actually sent
- Fixed: switching mode over a remote attach sent nothing over the wire. The footer was local and
  the gate was in the daemon, so a mode change made before `set_mode` was a local edit of a label
- Fixed: four report surfaces (`/status`, `/doctor`, `/stats`, `/setup`) read the substitute in the
  config file rather than the live gate, so they could name a mode that was not the one refusing
  calls — the `settings.json` door above widened that window further

## 0.85.2 (2026-09-23)

- Version sync with Mipham Code CLI 0.85.2
- Security: path-scoped permission rules matched the literal path spelling, so a symlink whose
  **name** matched an allow rule but whose **target** was a protected file (a `notes.txt`
  pointing at `.env`) was silently permitted — and a `deny` rule was erased the same way.
  Matching now also tests the resolved path. Both directions are fixed: this is one shape with
  two mirrors, and the `deny` half landed separately from the `allow` half
- Security: MCP OAuth credentials were cached by server **name** alone. That name comes from the
  project-level `.mcp.json`, so pointing a familiar name at a different issuer silently handed
  the previously issued token to the new host. Credentials now carry a binding; any of the
  bound values changing means re-authorisation
- Security: the invisible-character strip set was a closed range that swallowed ZWNJ and ZWJ.
  Both are load-bearing rather than a hiding trick — ZWNJ holds Persian/Arabic word forms
  together, ZWJ is how a family emoji stays one glyph — so writing a file silently rewrote its
  content. Neither can hide anything at the execution layer
- Fixed: `Ctrl+C` with a dialog open (key prompt, model picker) killed the whole CLI, taking the
  half-typed input with it, instead of dismissing the dialog. The root cause was that our
  handler never ran — Ink exits the process on Ctrl-C before any handler sees the key
- Fixed: a config path that is a FIFO hung startup forever, with no output and no error. The
  gate now tests the file **type**, not its existence (`existsSync` is true for a FIFO, a
  socket, a device node and a directory alike, and reading a writer-less FIFO blocks
  synchronously, where no timer or signal handler can run)
- Fixed: state files were written non-atomically and the read side turned "cannot read" into
  "empty", so one interrupted write cost **all** of the rules / signatures / statistics /
  memory, not one entry. 25 modules now write atomically, the read side validates shape, and
  two two-way guards keep the family from growing back
- Fixed: a hook that timed out, a hook command that did not exist, and a hook killed by a signal
  all reported the same empty reason. The three shapes are now distinguished, and a failed write
  to a hook's stdin no longer replaces what the hook actually said
- Fixed: messages sent to a background agent were never delivered. The address was advertised
  (`taskId="bg-…"`), accepted by the router, and answered `success: true` — but nothing ever
  drained the inbox
- Fixed: a subagent had no circuit breaker, so a tool call the permission layer kept refusing
  was retried round after round until the whole run was consumed
- Fixed: a failed turn left the provider's error text as a `system` entry inside the message
  array, and the OpenAI-compatible providers sent it as-is — promoting provider-supplied text
  to the highest-privilege role. The summarisation instruction travelled the same way and so
  reached only half the providers
- Fixed: `Task output` / `Task stop` only knew the local task id space, so the `bg-…` id that
  the `agent` tool advertises always answered "not found"

## 0.85.1 (2026-09-23)

- Version sync with Mipham Code CLI 0.85.1
- Fixed: pressing Ctrl-C during `mipham update` could still leave a half-written install. The
  rollback added in 0.85.0 runs inside the CLI process, but the terminal delivers SIGINT to the
  whole foreground process group — the CLI and npm died together, so the rollback never ran. The
  install step now runs detached (its own process group, so the terminal's SIGINT cannot reach
  npm) and the CLI holds a SIGINT guard for the duration of the install, released on both the
  success and the failure path. The trade-off, stated plainly: **Ctrl-C is ignored while the
  install runs** — to interrupt it, kill the process from another terminal

## 0.85.0 (2026-09-22)

- Version sync with Mipham Code CLI 0.85.0
- Fixed: `mipham update` could delete your CLI entirely. `npm install -g` rewrites the package
  directory in place (it is not an atomic swap), and the install step was wrapped in a 10-minute
  timeout — while the package is 84 MB / 6,601 files and can take longer than that on a slow link.
  A timer that fires mid-install leaves neither the old version nor the new one, so `mipham`
  disappeared, together with the very `mipham update` command you would retry with. The install
  step no longer carries a timeout (only the read-only registry lookups do), and an update now
  snapshots the install first, verifies afterwards by actually running the launcher, and rolls
  back if that check fails

## 0.84.0 (2026-09-22)

- Version sync with Mipham Code CLI 0.84.0
- New: a permission classifier for the `auto` mode — fail-closed, wired to the only two runtime
  gates. It may only narrow what an allow rule already permits, never widen it, and an
  organization-level ceiling still caps it
- New: every `auto`-mode verdict is appended to `~/.mipham/permission-audit.jsonl`
  (append-only, 0700/0600). Both the verdict and the level are recorded — the ceiling can turn a
  would-be allow back into an ask — and tool arguments are never recorded
- New: the footer glyph is now chosen per mode; the `default` mode no longer shows the
  auto-accept glyph that it does not have
- Fixed: input history was emptied every time the model picker opened — it lived inside a
  component that `app.tsx` unmounts on three separate paths. It is now held by `app.tsx`
- Fixed: `config.yml`'s `permission:` now recognises mode names. Previously every value except
  `bypass` silently fell back to `default`, so asking to narrow a mode could move the gate the
  other way
- Under the hood: the Shift+Tab four-mode cycle and the input history now have wiring-layer tests
  that drive real key sequences, instead of only pure functions and source-text assertions

## 0.83.0 (2026-09-21)

- Version sync with Mipham Code CLI 0.83.0

## 0.82.0 (2026-09-20)

- Version sync with Mipham Code CLI 0.82.0

## 0.44.3 (2026-08-17)

- Add plugin logo (`META-INF/pluginIcon.svg` + `pluginIcon_dark.svg`, 40×40 vector)

## 0.44.2 (2026-08-17)

- Remove `<icon>` from plugin.xml (unsupported in IntelliJ 2024.3; caused "invalid plugin descriptor")
- Ship plugin icon as standalone asset for the Marketplace listing

## 0.44.0 (2026-08-17)

- Version sync with Mipham Code CLI 0.44.0
- Wire plugin settings (bun path / provider / model) into the start command

## 0.21.0 (2026-08-07)

- Initial release
- Start Mipham Code in IDE Terminal (`Cmd+Esc`)
- Focus existing Mipham terminal (`Cmd+Shift+M`)
- Open plugin settings (`Tools → Mipham Code: Open Settings`)
- Configurable: bun path, default provider, default model
- Compatible with IntelliJ IDEA, WebStorm, PyCharm, GoLand, Rider, CLion, DataGrip
