# Mipham Code — VS Code Extension Changelog

> Entries for 0.75.0–0.81.2 were backfilled on 2026-09-14 from the root `CHANGELOG.md`
> (tag dates). The extension is a thin launcher, so CLI-facing changes are listed here too.

## 0.85.6 — 2026-09-26

- Version sync with Mipham Code CLI 0.85.6
- Fixed: `mipham update` now installs by atomic swap, so a half-written tree is gone by
  construction. The old flow was snapshot → `npm install -g` rewriting in place → self-verify →
  roll back, and `npm install -g` has no atomic handover: killed mid-way (timeout / Ctrl-C /
  SIGKILL) it left "old tree deleted, new tree not written" — not a single `mipham` on the machine,
  including the `mipham update` you would retry with. It now installs into a staging directory
  **inside** `<prefix>` (same filesystem required; `os.tmpdir()` hits `EXDEV` on Linux tmpfs, which
  would force a copy — exactly the interruptible state being removed) → runs both self-checks on
  staging → two renames (old tree aside, new tree in) → verifies once more after the swap → cleans
  up. The window shrinks from minute-scale to µs. Rollback goes exclusively through reverse rename
  and the copy-based snapshot machinery is retired. Failure messages went from a `rolledBack`
  boolean to four states (`untouched` / `restored` / `broken` / `unknown`) — in the most common
  failure (staging will not install) the old tree was never touched, so the old wording "cannot
  restore your previous installation" was a false statement about the user's machine
- Fixed: on Windows every `mipham update` rolled back the version it had just installed. npm puts
  the global package under `<prefix>/node_modules` on win32 (no `lib` layer) with the bin shim at
  `<prefix>` itself, while the code applied Unix's four `..` levels on both platforms ⇒ the prefix
  went one level too far and the launcher pointed at a file that never exists ⇒ the second
  self-check (really running the launcher) had to fail ⇒ Windows users could never upgrade, and
  were told "failed" every time. The same spot also skipped the check that its computed path really
  is a node prefix. `platform` is now an injectable parameter, so both layout branches really run on
  any machine — that half read `process.platform` directly and never ran on a dev machine or CI
- Fixed: the caller's cancellation never reached the transport. `ChatRequest.signal` had a
  declaration, a consumer and setters, but no deliverer: neither provider passed it into its `fetch`
  init, so that `AbortController` was never connected once, and `abort()` on an unobserved signal is
  a no-op — `critique()`'s documented "null if … timed out" never took effect (the real fallback was
  the provider's own 90 s stream idle timeout). Delivering it cannot be that one line alone: the
  retry helper's `finally` aborts the combined signal it had just handed to `fetch`, while the
  caller reads the body after the function returns ⇒ every stream would be killed by itself at the
  response headers. Now `AbortSignal.any`, which holds the source weakly, stays alive through the
  body read, and needs no cleanup
- Fixed: the connection was never released when the consumer walked away. Neither provider's
  streaming read loop had any `reader.cancel()`, and consumers do leave mid-stream (the engine
  breaks on a `stop` block; a sub-agent throws on abort). Patching each exit only covers the exits
  the loop knows about, not "the consumer left mid-stream" — which is the ordinary shape of this
  path, so the read loop and the fallback `stop` after it are wrapped in one `try/finally`
- Fixed: ghost-text completion had no ceiling upstream and could not be cancelled downstream. The
  staleness check sat outside the loop (it belongs inside, checked per chunk): outside means
  draining the whole stream before discarding the result, so every pause over 400 ms bought a
  complete completion. The ceiling was on count only (6 messages) while one message can be
  arbitrarily long — paste a file in and six messages is tens of thousands of tokens; each message
  is now truncated to 2,000 characters keeping the tail (a continuation cares about where it just
  got to) and marked as truncated. Tab-to-accept is now covered at the wiring layer too: the pure
  functions were pinned one by one, but nothing had ever touched the input bar itself, and green
  pure functions do not prove Tab really merges the suggestion into the body
- Fixed: after `--resume`, the context estimate was overwritten by the system prompt alone. Restore
  first estimated "system prompt + all messages", then immediately recomputed from the system
  prompt only, so the entire message part was overwritten — and `needsCompaction()` reads exactly
  that field ⇒ after restoring a long session, compaction fired late and the context grew large
  first. There should be one derivation of the estimate; the hand-written second algorithm is gone
- Fixed: a sub-agent's declared `memory` never reached the model. It was composed into the
  sub-agent's own context, but then the version without the memory was set again, and the request
  reads that local variable — so `memory:` was declared in the definition and displayed in
  `/agents` while not a word of it reached the model, in the context or in the request. The
  composition rule now lives in exactly one place and the request reads the assembled copy
- Fixed: five spots on the read side used `JSON.parse` results as their declared types. The write
  side had been closed long ago; the read half had not, and the dangerous cell is "valid JSON,
  wrong shape" — it does not throw, so `catch` cannot hold it and nothing else speaks up: dream
  history (`{"a":1}` returned as an array, and the call site's `.length` raising a TypeError into
  the UI), the error-signature DB (`["x"]` accepted verbatim, holding a member with no id that the
  stats denominator still counts), the effectiveness ledger (indices read as keys), the memory link
  graph (a string iterated per character, splitting one link into two), and recall stats (a `catch`
  outside the loop, so one bad record cost every entry after it)
- Fixed: the footer froze the graft status from the moment of startup. The `useState` initializer
  runs once, and that file is written by someone else in the background: starting right when a
  rebuild happened left `syncing…` on screen forever while disk already said `syncing: false`. It is
  re-read on a tick now, and state changes only after verifying it really changed. The file's own
  doc comment had written that freeze down as the design — the comment was covering for the defect
- Fixed: `daemon.log` has a ceiling. The log only ever grew, and a daemon that repeatedly fails to
  start would fill that disk. It rotates at startup (after mkdir, before open — the only moment with
  no writer), by renaming rather than truncating: what this scenario needs to keep is the previous
  generation, since for a daemon that keeps failing to start the last run's log is the whole clue.
  One generation only, so the ceiling is a constant 2 × 5 MiB. The other unbounded append sink in
  that directory (the permission audit ledger) is deliberately left alone — silently dropping lines
  from an audit ledger is a policy decision; its value is the whole set, not the tail
- Fixed: `daemon start` no longer abandons a child it started. A deadline is a prediction, not a
  fact, so it re-probes once before giving up — a daemon that came ready right on the line should
  not be killed — and when it really did not come up it now reaps its own child. Leaving that
  process behind would make the next `daemon start` report it as a success on the already-running
  branch

### Added

- Top-level `--provider` / `--model` flags. Both published IDE extensions assemble a launch
  command of the form `mipham --provider <id> --model <id>` from their settings, and before this
  the CLI answered `Unknown command` with rc=1: that value fell through to the positional
  arguments and hit the unknown-command branch, which runs before any flag parsing. Values are
  used verbatim, not validated against the registry — providers can be user-defined, so a static
  allowlist would reject them wrongly; an unknown id is named by the registry on the first
  message, exactly as when the same value comes from `config.yml`. This is the flag these two
  extensions already need

## 0.85.5 — 2026-09-25

- Version sync with Mipham Code CLI 0.85.5
- Fixed: a recursive `rm` whose target cannot be read from the command text is refused outright.
  Four shapes: the target exists only in a command substitution (`rm -rf "$(pwd)"`); a variable
  followed by a root-level directory name (`$VAR/usr` — an unset variable is dropped, not an
  error, leaving `/usr`); a target anchored on the working-directory variables
  (`$PWD`/`$OLDPWD`); and a command that is nothing but backslashes. The gate sits ahead of the
  allow rules and of every mode's baseline — all of them read the same text, so auto never asks
  the classifier. The exemption is the `MIPHAM_DISABLE_DANGEROUS_RM_PROMPT=1` environment
  variable, not a tool parameter. The refusal says it covers the result, names the target, and
  states that `/permissions` cannot lift it
- Fixed: `Retry-After` from a server was trusted with no ceiling. `3600` pressed the CLI into an
  hour-long sleep with nothing on screen to cancel it; `0` made retries back-to-back; an
  unparseable value became `NaN`, which `setTimeout` reads as 0 — the same shape as the first,
  but silent. It is now clamped to [1s, 60s], and unparseable values fall back to exponential
  backoff
- Fixed: a plugin's remote MCP servers were dropped without a word. The loader gate required
  `command` while `command` and `url` are two mutually exclusive transports, so every server
  declared with a `url` was discarded silently: the plugin looked installed and its tools simply
  never appeared. The gate now accepts either transport and names the file and server it skips;
  `plugin validate` reports declarations that would be dropped, `${user_config.*}` references
  with no substitution step, and plaintext `http://` URLs (loopback exempt) as warnings that do
  not block installation
- Fixed: plugin hooks were anonymous. Inside the engine they were indistinguishable from the
  hooks an operator writes in `settings.json`, with three consequences: failure text never said
  whose hook had failed (a plugin's command is usually `sh`, `node` or a path, none of which
  names anything); the health key was the event alone, so two hooks on one event shared a failure
  count and a disable bit — a broken plugin hook failing five times would auto-disable a
  neighbour that had never failed; and uninstall scanned by event, so removing plugin A removed
  **every** hook on those events, the operator's included. Hooks now carry their source, failures
  name it, health is keyed per hook, and uninstall removes only what that source declared. Hooks
  with no source keep their exact previous wording and keys
- Fixed: the `mcp_tool` hook was a stub. The type list carried it and the config carried
  `mcpServer`/`mcpTool`, but the executor matched the case and returned `{ allowed: true }`: a
  settings file saying you were being guarded guarded nothing. It now makes the call, passes the
  event context as arguments, reads the answer by the same contract as command hooks, and waits
  for the connection to settle (up to the handshake's own timeout) instead of reporting "not
  connected" for "still connecting". `isError` is reported but never turned into a deny
- Fixed: a truncated turn no longer passes as complete. If the stream never reached
  `message_stop` — a proxy or gateway closing the connection cleanly looks byte-for-byte like a
  normal finish — the truncation flag left through an exit that did not carry it, so "hit the
  output ceiling" and "cut off mid-stream" both read as a clean finish. Streams now track whether
  a terminal event was seen and warn before releasing the stop
- Fixed: a replayed stream event no longer runs a tool twice. A `content_block_stop` re-sent by a
  proxy emitted two `tool_use` blocks for one call, and the engine ran the tool twice — two
  writes, two commits, twice everything that tool does. Blocks are now deduplicated by id;
  different ids still emit once each
- Fixed: the tool-turn cap was a per-loop budget rather than a per-conversation one. `MAX_TURNS`
  was a function-local constant, and every Stop-hook block re-issued a fresh 100 turns, so a hook
  that is never satisfied ("don't stop until the tests pass", with a model that cannot fix them)
  made the turn never end. Remaining rounds are now threaded through, and a spent budget surfaces
  a warning carrying the hook's own reason instead of silently ignoring it. The hook itself is not
  weakened: a hook that blocks once still resumes one round, with no notice
- Fixed: a working directory deleted mid-session. Startup had a gate for it; nothing caught the
  directory disappearing while running, and "the runtime will complain" does not hold — Node
  throws from the call site that touches it and names something else, while Bun (this project's
  preferred runtime) does not throw at all and keeps returning the path cached at startup, handing
  tools an ordinary-looking string for a directory that is gone. The filesystem is now the judge,
  so both runtimes give the same answer: the tool does not run, and the result says the session's
  working directory no longer exists and to restart from one that does
- Fixed: resuming a session whose log ends on a tool call with no result. The provider rejects
  such a history outright, so an unfinished call surfaced to the user as "the first thing I say
  after resuming is a protocol error". A "result unknown" event is now appended — an event rather
  than a message injected into the projection, which would break the invariant that everything
  the model can see is logged — telling the model to go verify instead of assuming either way
- Fixed: concurrent connections to the same MCP server by name are now merged. The two sources at
  startup are concurrent and neither is awaited, and `connect()` treated only `connected` as
  connected, so the second one started a second transport and the one it replaced — along with its
  stdio child process — was never closed. Handshakes in flight now merge, and the name is released
  in `finally` either way, so a failed connect can really reconnect
- Fixed: a burst of keys no longer lands on the previous line. Keys arriving in one chunk are
  dispatched one by one while React has not yet committed the first callback's state change, so
  the second callback still reads the previous closure: "↓ then Enter" acted on the line above the
  one the ↓ moved to. The cursor now keeps a synchronous mirror that every decision reads, so
  changes within one burst also accumulate. Both levels of the model picker, the command picker
  and the setup wizard are covered
- Fixed: the command picker submitted twice on one Enter. Two listeners handled Return (the
  component's own `useInput` and the text input's `onSubmit`), so `onSelect` ran twice — one key
  press, the command ran twice. Enter is now handled in one place

### Added

- Startup now reports the **total** size of the instruction files. The loader reported what was
  missing, never what was too much, and too much does not grow from one big file: the three
  instruction layers, the per-directory rule files and the lessons block are each small and
  together still crowd out the work. It counts what is actually sent (excluded sections excluded)
  and says a word once the total crosses 40,000 characters — a threshold on the total only, since
  a per-file threshold is exactly the shape this fixes

## 0.85.4 — 2026-09-24

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

## 0.85.3 — 2026-09-23

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

## 0.85.2 — 2026-09-23

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

## 0.85.1 — 2026-09-23

- Version sync with Mipham Code CLI 0.85.1
- Fixed: pressing Ctrl-C during `mipham update` could still leave a half-written install. The
  rollback added in 0.85.0 runs inside the CLI process, but the terminal delivers SIGINT to the
  whole foreground process group — the CLI and npm died together, so the rollback never ran. The
  install step now runs detached (its own process group, so the terminal's SIGINT cannot reach
  npm) and the CLI holds a SIGINT guard for the duration of the install, released on both the
  success and the failure path. The trade-off, stated plainly: **Ctrl-C is ignored while the
  install runs** — to interrupt it, kill the process from another terminal

## 0.85.0 — 2026-09-22

- Version sync with Mipham Code CLI 0.85.0
- Fixed: `mipham update` could delete your CLI entirely. `npm install -g` rewrites the package
  directory in place (it is not an atomic swap), and the install step was wrapped in a 10-minute
  timeout — while the package is 84 MB / 6,601 files and can take longer than that on a slow link.
  A timer that fires mid-install leaves neither the old version nor the new one, so `mipham`
  disappeared, together with the very `mipham update` command you would retry with. The install
  step no longer carries a timeout (only the read-only registry lookups do), and an update now
  snapshots the install first, verifies afterwards by actually running the launcher, and rolls
  back if that check fails

## 0.84.0 — 2026-09-22

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

## 0.83.0 — 2026-09-21

- Version sync with Mipham Code CLI 0.83.0
- New: the CRSI eval ledger now records every contract's `{id, passed, role}` instead of an
  aggregate score alone, so `/crsi eval` can show _which_ contract flipped (a real regression and
  a one-off flake look identical in the aggregate)
- New: the improvement ledger records before/after durations alongside scores, shown as one line
  by `/crsi modify` and `/crsi propose --prose`; durations are recorded only and gate nothing

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
