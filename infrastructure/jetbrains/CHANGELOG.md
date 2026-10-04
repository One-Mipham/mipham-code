# Mipham Code — JetBrains Plugin Changelog

> Entries for 0.84.0–0.85.4 were backfilled on 2026-09-24 from the root `CHANGELOG.md`
> (tag dates) and use the same wording as the VS Code extension's changelog — the plugin is a
> thin launcher, so CLI-facing changes are listed here too.

## 0.85.17 (2026-10-04)

- Version sync with Mipham Code CLI 0.85.17
- Fixed: **a tab no longer draws over the row below.** `stripControlCharsForDisplay` used to keep
  `\t` as a safe character — but it is the one gate through which tool arguments, tool output and
  model prose reach the terminal. The old test ("a tab cannot move the cursor backwards or open an
  escape sequence") was the wrong one: Ink lays text out with `string-width`, which scores a tab as
  **0 columns**, then writes the tab through to the frame, so the terminal advances it to the next
  tab stop (up to +8 columns) and the row ends up wider than the width Ink budgeted — drawing over
  the row below. Its danger is advancing _unknowingly_, not moving backwards. A tab now normalises
  to a **single space** (normalise first, then strip C0/C1, the same move
  `stripControlCharsForCheck` makes), so words do not merge.

## 0.85.16 (2026-10-03)

- Version sync with Mipham Code CLI 0.85.16
- Fixed: **dangerous-command detection is no longer `rm`-shaped only.** Quotes join the separator
  class, so `rm -rf '/'` takes the same path as `rm -rf /` (the quoted form matched nothing before);
  `rm -rf .`, `./` and `../` join the refusal set — they delete the working directory itself — while
  `./build` and `../vendor` stay ordinary paths and still pass. The nested-interpreter rule was
  rewritten to "any option string after the interpreter, with `-c` allowed inside a cluster"
  (`bash -lc 'rm -rf /'` slipped through), and `ash` / `fish` / `csh` / `tcsh` were added.
- Fixed: **control characters in tool arguments, tool output and model prose no longer reach the
  terminal.** New `stripControlCharsForDisplay` keeps `\t` / `\n` and drops CR, ESC and the C1 range,
  wired at the one place that turns any of the three into terminal output. `sanitizeInlineField` is
  single-line by design and discards `\n` along with the rest, so it was never a substitute. Measured
  against the render layer: it passes CR / BS / BEL / VT / FF / DEL / NUL through, and rewrites
  `\x1b[8m` into `\x1b[28m` and emits it — "the renderer handles it" does not hold. The shape is
  `printf 'safe.txt\rrm -rf /'`: one line on screen, another one executed.
- Fixed: **an ordinary reply commits its assistant turn once.** The turn was hung on "received
  `stop`", and an OpenAI-compatible reply sends `stop` twice (`finish_reason`, then the trailing
  `[DONE]`) — so the same assistant message was appended twice and the model saw its own answer
  doubled on the next turn. It is now committed once, after the stream ends.
- Fixed: **a turn that spends its whole budget thinking is no longer accepted as an answer** (thinking
  present, no text and no tool_use). It now takes the same same-provider retry as an error; the
  cross-provider fallback warning carries `restart: true`, without which the attempts' `tool_use`
  blocks stack up in context and side-effecting tools run twice.
- Fixed: **a sub-agent keeps the turn it already produced when the stream fails mid-flight.** It used
  to throw and fail the whole sub-agent, with `chunks` handed back only on a clean exit; partial
  output is now kept and the stream stops (a shorter answer beats none). Empty output still counts as
  a real failure.
- Fixed: **a bad hook matcher no longer takes the whole group down.** A throwing `new RegExp` aborted
  startup, or aborted wiring for every hook in that session; it now warns, and that hook runs on every
  call (the documented fail-closed direction).
- Fixed: **an MCP 401/403 no longer looks like an ordinary transport error.** The
  `WWW-Authenticate` challenge is read and sets `needsAuth`, saying the credentials were rejected and
  pointing at re-authentication; OAuth servers now actually inject `MCP_ACCESS_TOKEN` into the MCP
  child process (that variable previously had zero readers).
- Fixed: **`/mcp connect` and `/mcp reload` actually connect and disconnect.** Both used to hand the
  AI "call this internal method that no tool exposes", so nothing was connected or closed and a status
  line was printed instead.
- Fixed: **a cross-session "delivered" no longer lies.** With the recipient's policy at `ask` (the
  default) the message only lands in the inbox — unseen and refusable; the sender now reads
  "Message Queued — not delivered" and the holder is named. `deny` already reported a refusal; `ask`
  was the one dishonest cell.
- Fixed: **a half-written trailing line in the session log is no longer discarded as corruption.**
  Every line ends in `\n`, so a trailing segment without one can only be a line still being written;
  it is now re-read a bounded number of times (5×20ms, with no spin on an empty file). A session saved
  while being resumed used to lose a turn.
- Fixed: **the `Agent` tool can be dispatched in manual mode.** Its `permission` changed from `'ask'`
  to `'self'`. The dispatch gate duplicated the sub-agent's own gate — the child is built with the
  caller's **same** permission system and re-runs the gate on every tool call — and this CLI has no
  interactive approval prompt, which makes `ask` a hard refusal. The observable result was that
  `default` (manual) mode could not dispatch a single agent: the advertised fan-out had no landing
  point on the branch production runs. `Write` / `Edit` / `Bash` are still `ask`, with a regression
  test pinning that cell so that "opening dispatch" and "opening the whole mode" cannot be confused.
- Removed: the MCP registration line in the startup banner (`[mcp] N server(s), M tools registered`) —
  with five configured servers it was a line of scrollback before first paint, and nothing in it was
  something the user acts on. Failure lines are still printed.

## 0.85.15 (2026-10-02)

- Version sync with Mipham Code CLI 0.85.15
- Fixed: **the `rm` deny rule no longer requires the target to be the last thing on the line.** Three
  rules were anchored at end-of-line, so `rm -rf /*` was refused while `rm -rf /* foo`,
  `rm -rf /*; echo hi`, `rm -rf /* > log` and `rm -rf * foo` all passed — and those five spellings are
  the same deletion. The anchor is now "followed by a separator, or end of line", and the refusal
  message no longer echoes the internal regex. Boundary, stated honestly: the hazard was reachable
  only in the `auto` / `bypassPermissions` modes, or when an allow rule matched — `default` already
  refuses Bash.
- Fixed: **a hook that cannot run is now actually auto-disabled.** The executor reported "missing
  command / spawn failure / option rejected" as `{ allowed: true, hookError }` without throwing, while
  the engine counted failures only in `catch` — so a genuinely broken hook was recorded as a success,
  re-injected its error every turn, and `MAX_CONSECUTIVE_FAILURES` never fired: auto-disable was
  unreachable code. `HookResult` gained `hookError`; a `command` hook exiting non-zero is deliberately
  still not one (some hooks use the exit code to express a policy decision).
- Fixed: DingTalk Stream registration now times out after 10 seconds — a gateway that accepted the
  connection and then went quiet left the promise pending forever, so the reconnect was never
  scheduled: a silent channel with no error to look at.
- Fixed: the startup "instruction files over budget" notice lists every file instead of folding the
  tail into `+N more` — the folded ones are exactly the files the reader has to open in order to act,
  and a file that appears only as a count cannot be reconciled against its contribution to the size.
- Removed: **`/fast`** — the only command in the repo with a keypress and no landing point, since its
  handler set a `useState` that nothing ever read. Its advertisements went with it (help text,
  registry, category and description tables, both i18n copies, the CLI README, the bundled setup
  skill). Command count 138 → 137.

## 0.85.14 (2026-10-02)

- Version sync with Mipham Code CLI 0.85.14
- Fixed: **a retry could replay a whole turn, running side-effecting tools twice.** When
  `chatWithFallback` hit a retryable failure it re-sent the entire turn in place, but `tool_use`
  blocks already yielded could not be taken back, so the two turns' calls stacked up (tool-call ids
  are generated per call server-side, so nothing downstream could dedupe them) — `rm`, file writes
  and POSTs ran twice. The fix is not to stop retrying but to make "the previous turn is void"
  consumable: a new `StreamChunk.restart`, set only on the retry path, which both accumulation
  points (`process` and `continueWithTools`) honour by dropping the previous turn — wiring only one
  of them is exactly how the other rendering path stays broken.
- Fixed: tool continuation rounds no longer bypass retry/fallback — `continueWithTools`' two model
  calls now go through `chatWithFallback`. Previously only the first call in a user turn enjoyed
  "retry once within a provider + fall back across providers"; continuation rounds had only the
  transport's three retries.
- Fixed: a model refusal is now visible. `stop_reason: 'refusal'` is a 200 response that may carry
  empty content, which used to look like the model saying nothing. It is now reported via
  `StreamChunk.refusal`, named by the engine, and paired with a bilingual notice.
- Fixed: the cross-provider fallback notice now mentions the context-window downgrade, not just the
  provider/model.
- Fixed: outbound tool results are coerced with `String()`.
- Fixed: messages handed back by a sub-agent now use the agent's own name (the sender used to be a
  synthesized `sub-agent-<timestamp>`, recomputed per message, so one agent's two messages appeared
  as two different senders).
- Fixed: a synchronous (foreground) sub-agent is no longer promised a reply channel it cannot receive.
- Fixed: `/login` recognises providers configured in `config.yml`, not just environment variables.
- Fixed: plugin installation pins the registry.
- Fixed: `/` completion and the command picker use one filter rule (one matched name+description,
  the other only name).
- Fixed: `/fork` creates its worktree via argv instead of a shell string.
- Fixed: MCP OAuth now listens for the `'error'` event.
- Security: `Authorization: Bearer <token>` and bare `Bearer` / `Basic` shapes are now masked — the
  previous rules only recognised key names and known value shapes, so an arbitrary opaque token
  passed through verbatim.
- Security: zero-width characters can no longer bypass key-name masking (`"apiKey"` with a
  zero-width space reads as `apiKey` to a human and as nothing to a regex); format characters are
  stripped before matching, with ZWJ/ZWNJ deliberately preserved.
- Security: `maskOutput` no longer corrupts JSON — the old replacement covered only the first match,
  and in compact JSON (no spaces) that first match swallowed every pair after it; `/config` prints
  `JSON.stringify(config)`, which is exactly compact JSON. It now scans explicitly and resumes after
  the masked value.

## 0.85.13 (2026-10-01)

- Version sync with Mipham Code CLI 0.85.13
- Changed: the `auto`-mode gate's ruling budget is now **measured** rather than guessed —
  `DEFAULT_CLASSIFIER_TIMEOUT_MS` 2,000 → **30,000**. Over 24 real `ask`-level calls × two model
  tiers, same machine, same moment, with the model for each request **read back** from the wire
  instead of trusted from a label: the active tier has a median of 7.6s / p90 35.6s / max 120.0s, so
  **the old 2s would have discarded 23/24**; the fast tier is 1.3s / 3.7s and still discards 9/24.
  **The old value wasn't too tight, it was measured wrong** — this gate is fail-closed, so a timeout
  and a refusal look identical to the user, which means "too tight" isn't "slow": it is `auto`
  intermittently refusing work it should have allowed.
- Added: `permissions.classifierModel` / `permissions.classifierTimeoutMs` — which model rules and
  how much budget it gets is configurable for the first time. Three-tier semantics: absent or
  `'active'` ⇒ the current model (re-read on every ruling), `'fast'` ⇒ a Flash-class model falling
  back to the current one when none is found (it never invents an id), anything else used as-is by
  id. Both keys are treated as **widening** directions, so they are accepted at the **user level
  only**; a project-level value is withheld and reported as `projectClassifierSkipped` — otherwise
  cloning a repository would let it widen permissions on the operator's behalf.
- Security: **recursive `chmod` granting world-write to an unbounded target** moved out of the
  classifier into a deterministic rule. The criterion is structural and text-decidable, so it should
  not sit with a model that swings from run to run (the active tier allowed 1/5, the fast tier 4/5 —
  the widest spread in the whole sample). **Authorization** is read from the mode token (the operator
  matters, not whether a `w` appears — `o-w` / `go-w` are not grants); **boundedness** is read from
  the target (`/tmp/shared`, `$DIR`, `~/x`, `"$(pwd)"`, `../x` escape the bound the command itself
  declared; `./dist` bounds it). The new refusal reason `world-writable-chmod` is **not** in
  `CLASSIFIABLE`, so it is judged statically and fail-closed and the classifier is never consulted —
  the same shape as `dangerous-rm`. `chmod -R 777 ./dist` is deliberately left with the classifier,
  since a bounded relative target is routine work. An operator escape hatch
  `MIPHAM_DISABLE_CHMOD_PROMPT=1` is provided. **Recorded honestly**: this gate did not previously
  exist at the static layer — bash's own `BLOCKED_PATTERNS` catches only **absolute** targets
  (`$DIR`, `~`, `$(pwd)`, `./dist` all passed in testing), and `MANAGED_DANGEROUS_RE` only **warns**
  and sits **after** the permission gate.
- Security: `axios` hardened to 1.20.0 — a newly disclosed high-severity advisory that lands in the
  **production** tree (`@miphamai/cli > @larksuiteoapi/node-sdk > axios`), so shipping is what
  actually protects users.

## 0.85.12 (2026-09-30)

- Version sync with Mipham Code CLI 0.85.12
- Fixed: eighteen places where **a capability had a name but its point of application was missing,
  or was missing the one link that makes it work**. Three of them are the same problem already
  solved next door and not here. **Six real gaps**: the credential masker's password group excluded
  `@` (`([^/\s@]+)`), so `https://user:p@ss@host` masked only as far as `p` and leaked the tail
  `ss` — masking is on by default, at bash stdout/stderr, grep file contents and config text, so the
  password suffix reached the model context and the session log; a **sub-agent** calling Agent was
  sent to the background too (`?? true` in `resolveRunInBackground`), so it only got back the
  placeholder `[background-task:bg-…]` and its child's result **never returned** to the sub-agent
  that started it; a rejection **not awaited** inside a workflow took down the whole CLI
  (`await workflowAgent(…)` had no try/catch, so it landed in the unconditionally installed
  `unhandledRejection` ⇒ `exit(1)`) — now caught and journalled (an `error?` field) with a
  no-error-listener guard added to `event-bus`; hooks used `spawnSync`, which freezes the event loop
  for as long as a process they spawned holds an inherited pipe (20,020 ms measured with a local
  probe) and then reports "timed out after 60s" — a **misdiagnosis**, since the hook had long since
  exited — now async `spawn` + `detached` process group + `HOOK_PIPE_GRACE_MS`, killed by group;
  `ToolContext` had sixteen fields and no `signal`, so a cancel had no path to tool execution at any
  moment (bash now runs in its own process group, and "exit code 0 also counts as failure");
  cross-provider fallback called the registry directly, bypassing `engine.switchProvider`, so the
  one `context.updateMaxTokens` never fired and the compaction trigger ran off a **stale** window
  (falling back from 1M to 128K compacted only around 950K). **Ten half-gaps**: an error object in
  the stream is no longer silently swallowed; an unreadable or unparseable settings.json is no
  longer silent (both branches write to stderr, `existsSync` telling "absent" from "present but
  unreadable" — one malformed JSON no longer quietly zeroes configured permissions); plugin
  uninstall now uses `unregisterMcpServerTools` (it used to delete keys built from the **raw**
  server name while registration had gone through `sanitizeName`, so tools whose names needed
  sanitising stayed behind — "no error" on uninstall, every such tool orphaned); `/mcp` output
  passes server names, URLs and commands through `sanitizeInlineField` (C0/DEL and invisible
  characters); in-place retry gained `isRetryableFailure` (decisive failures — `content_filter`,
  401, 400 — are no longer resent; only **known** decisive error types count, and anything
  unrecognised retries as before, because guessing "already decided" throws away a recoverable
  turn); `truncated` counts against the score (a fully truncated batch used to score full marks
  with `passed: 0`); `exit-plan`'s `planFile` fallback is implemented rather than dead code (most
  recent `plan-*.md` by mtime); `MIPHAM_DISABLE_WEB_FETCH=1` removes WebFetch **at registration
  time** (a `permissionRules.deny` is a different mechanism: the tool is still advertised to the
  model and only refused on call, which burns a turn); artifact releases no longer duplicate the
  `List all:` line; `&nbsp;` is no longer shown literally in the terminal, which has no
  markdown/entities layer — **that one entity only**, deliberately not the code entities
  (`&lt;`/`&amp;`/`&gt;`), which would corrupt the code the assistant is displaying. **Two
  self-found**: web-fetch's User-Agent is no longer hard-coded to `Mipham-Code/0.24.0` (it uses
  `PACKAGE_VERSION`), and while a picker is open Escape goes to the picker (Ink 7's `useInput` has
  no stopPropagation, so the input bar and the command picker both responded to one Escape).
- Fixed: the CRSI sandbox had two `cwd` escapes, both of which only fire when `cwd` is not the
  repository root — and that is not the edge case: during a full `pnpm mutate` run `cwd` is a copy
  directory Stryker deliberately gives **no `.git`** (`apps/cli/.stryker-tmp/sandbox-*`), so
  `git worktree add` / `cherry-pick` / `branch -D` all silently climbed up to the **real repository
  outside** (reproduced under control: one run hit the same sandbox three times and made zero
  commits on `main`; leftover `crsi-sandbox-*` branches were the traces). Two fixes: the sandbox
  now accepts only the root of **its own** worktree, fail-closed and naming the outer repository —
  deliberately **not** "silently re-target to the outer root", which would be choosing a repository
  on the user's behalf, with the cost accepted and stated (starting in a subdirectory of a
  repository is refused, and the error says to run from the repository root); and every git command
  now carries its location **in the command string itself** (`git -C <root>` / `cd <root> &&`)
  behind a single `runIn()` exit — it used to rely on `cwd:` in an options object, and an
  object-literal mutant replaces the whole options object with `{}`, taking `cwd` with it.
- Changed: the compactor's second step is now wired to its own cache-economy gate —
  `shouldMicrocompact` had **no production call site** since it landed, while `runMicrocompact()`
  called `microcompact()` directly, so the "saved by dropping old tool_results vs lost to prefix
  cache invalidation" judgement was decoration. Boundary recorded as measured: under the production
  `PrefixCacheTracker` distribution the candidate set and the uncached set **do not intersect**
  (`keepRecent: 3` shields exactly the one uncached message) ⇒ `tokensSaved` is always 0 and the
  gate always closes ⇒ **no observable behaviour change in production**; this makes the rule live
  and skips a run that was certain to do nothing. The unread third parameter of
  `shouldMicrocompact` was removed — passing a real value for an ignored parameter is the **same
  shape** as advertising a capability with no landing point; the design document only ever had two
  parameters. Zero behaviour change. The mutation runner's test-name connector is pinned with
  `pnpm patch` (`@stryker-mutator/vitest-runner`) — development tooling, not runtime; a new guard
  pins the three links (declaration → patch file → the copy actually installed), because the
  weakest link is **deleting the declaration**, at which point pnpm silently reverts to the
  unpatched version.
- Security: the build-time dependency `brace-expansion` override is raised to 1.1.21 / 5.0.12 (two
  new high-severity advisories). Boundary recorded: it comes in only through
  `@stryker-mutator/core`, and none of the CLI's seven runtime dependencies touches it ⇒ this
  protects developer machines and CI and **gives users no protection at all**. It is listed so that
  the supply-chain surface of each batch stays auditable, not as a claim of any user-facing change.

## 0.85.11 (2026-09-29)

- Version sync with Mipham Code CLI 0.85.11
- Added: `/crsi lessons` now reports each resident lesson's **severity provenance**. `severity` is a
  normalised reading — a missing `- 严重度:` line, an empty value, and a value outside the closed set
  (e.g. `info`, or a typo) all fail open to `critical`, so "someone judged this should always be on"
  and "nobody ever wrote a severity" are **the same value**. And `critical` is the always-resident
  tier: every such lesson is sent with **every request**, forever. A new required field
  `severitySource: 'declared' | 'defaulted'` is computed from the **same raw capture** as `severity`
  (two readers sharing one capture — split them and you eventually get "the tier is the folded value
  but the provenance still quotes the original"). It is required, not optional: as an optional field
  the next construction site that forgets it gets a default that says **the opposite** (that someone
  judged it), and a value you must produce but cannot must be a compile error. Provenance is for
  human review only and takes part in no decision — pick, injection block and pointer are all pinned
  by a flip test that rewrites every `severitySource` to `defaulted` and demands the three outputs
  stay **byte-identical**. Known boundary, recorded rather than fixed: provenance **does not survive
  a merge** — the merger writes `- 严重度: <merged>` verbatim, so a lesson merged from two `defaulted`
  sources reads back as `declared`.
- Fixed: eleven items, all one shape — **a capability was declared but its point of application was
  missing or incomplete**. No model to fall back to now names the model and provider and offers the
  next step (`Ctrl+P`) instead of echoing a raw error that reads like "the model answered wrongly"
  when in fact **no model produced any output**. A failing active provider is **retried once in
  place** before cross-provider fallback (bounded at exactly once); 529 (upstream overload) joins the
  retry set alongside 503, while 4xx still is not retried. MCP tool calls now wait for a server that
  is mid-handshake, the same wait the `mcp_tool` hook uses. A hook's `additionalContext` reaches
  `hookWarnings` (its only channel to the model), and the line right after it no longer overwrites
  the whole thing. `permissionDecision` refuses only on **ask/deny** — `allow` is deliberately
  ignored, because a hook can come from repository-supplied settings and must not let itself through;
  the criterion is **direction, not key name**. Project-level agent definitions can no longer widen
  permissions **above** the parent tier, judged by a direction table rather than `indexOf`
  (`acceptEdits` and `default` are not comparable, and `indexOf` would miss two cells). The compactor
  **checks again after compacting** and runs a second, harsher pass if still over budget (bounded at
  two passes; the first is byte-for-byte equivalent to the old code). Memory text injected into the
  system prompt is neutralised first — invisible characters and `<…>`-shaped runs removed — so it
  cannot close the `system-reminder` block it is wrapped in; **neutralise before truncating**, or a
  tag spanning the cut becomes an unterminated shape that the outer `>` completes. `.mipham/rules/*.md`
  is now rejected and reported **by shape**: its body is injected verbatim into the session and sent
  to the model, so it is an **outbound** path and not merely a config directory, and the empty
  `catch {}` in `readDir` was letting symlinks, directories and FIFOs through. Rejection is reported
  to stderr, because **not loaded and not accepted are two different things** — otherwise "a rule in
  this repo was never loaded" looks identical to "there are no rules here". The autoloop prompts no
  longer ask the model to keep the CLI's own books: the old wording told it to call
  `logAutoloopIteration(...)` (a module export, **not a tool** — the model cannot call it) and to
  read and write `~/.mipham/autoloop/<id>.json` itself (which **overwrites** the iteration count,
  token total and status the CLI maintains).
- Fixed: three test fixtures now build by shape instead of depending on the repository layout — they
  had treated "what the real repo looks like" as a premise, and the mutation-testing sandbox flattens
  the repo into a copy of `apps/cli`, so that pipeline's dry run failed outright (the red was
  measuring the fixture, not the code under test).

## 0.85.10 (2026-09-28)

- Version sync with Mipham Code CLI 0.85.10
- Added: a **recall trigger for lessons**, attached to the "a tool call just failed" event rather
  than restated in the system prompt. Resident lessons go into the system prompt; the rest are
  demoted to a one-line pointer ("N not resident, at `<path>`"). A pointer says _the thing is
  there_; what was missing is _now is the moment to look_, and a moment can only attach to an
  **event** — putting it in the system prompt merely restates the pointer, at a cost paid every
  session. The two landing points first considered (after a context fold, on session resume) were
  dropped for that reason: resume **re-runs** `setSystemPrompt()`, so both pointers there are
  freshly generated. A failed tool call is the one moment the system prompt never spoke about and
  that is bound to the current event — this failure may be covered by a lesson. The **shape is
  forced by message pairing**: `injectContext` pushes a _user_ message, and inserting it between an
  assistant `tool_use` and its paired user `tool_result` breaks the pairing, so it cannot be
  injected inside tool execution; it is deferred until this round's tool results are all appended,
  the same timing the rules injection uses, which is why both call sites (first round and the
  multi-turn loop) are wired. The trigger reads the execution result's success bit rather than "did
  it throw" — failure returns come in eight shapes and per-return instrumentation would miss some.
  At most once per session. The wording is **non-directive**: it names, ranks and summarises no
  lesson, and does not decide for the agent whether to read. It shares the pointer's emptiness
  condition, so there is never a trigger without a pointer. Deliberately not wired into the daemon:
  the daemon never sets a system prompt, so that path has neither a resident block nor a pointer.
- Added: the **compiled binary reports its own usage** in CI. `bun build --compile` succeeding does
  not mean the artifact runs — entry points that fail to resolve at bundle time, unregistered
  subcommands and throws from top-level imports only surface on actual execution. The new step runs
  `--help` (commander's registry itself) and `--version` (which must match `package.json`
  verbatim — version drift makes the install script install something else, and no other step in
  the pipeline looks at that number). The check captures into a variable before grepping, avoiding a
  pipe: in `bin --help | grep -q`, grep exits on the first match, the writer takes SIGPIPE, and
  `set -o pipefail` records that as a step failure — whether it triggers depends on whether the
  output fills the pipe buffer, i.e. on luck.
- Security: **CI action references are pinned to immutable commit SHAs**. The `vN` in
  `uses: owner/action@vN` is a _movable_ ref — upstream, or anyone with write access to that repo,
  can point it at a different commit and our next CI run executes different code, while the workflow
  holds npm's OIDC publish right and the release-asset upload right. All **46** `uses:` references
  (CI 28 + Release 18) are pinned to 40-hex SHAs with the `# vN` comment kept: Dependabot's
  `github-actions` ecosystem understands this form and raises upgrade PRs from the comment, so the
  comment is not decoration. New guard `workflow-pinning.test.ts` with a **positive control**
  asserting "parsed count == raw `uses:` line count in source" — a regex that misses a spelling
  would leave the missed lines absent from the "all compliant" list, making that assertion a lie.

## 0.85.9 (2026-09-28)

- Version sync with Mipham Code CLI 0.85.9
- Added: `/crsi lessons` — a read-only roster of the always-on lessons, the first reader meant for a
  human. Until now the resident set had **no human reader at all**: the only selection point
  (`selectResidentLessons`) is called solely from places that hand the prompt to a model, so the
  person who could actually change a lesson's `severity` had no material to decide with. The command
  reports each lesson's real rendered cost and does an **addition self-check** (header + separators +
  items == what the renderer actually produced, printing the difference when it doesn't add up). It
  reads the selection's own output rather than re-deriving from raw summaries, so the report cannot
  drift from what really gets injected, and it reads the budget off the selection rather than off the
  constant, so it never prints a number that used to be right.
- Security: repository-supplied `allow` rules no longer take effect. `permissions.allow` **widens**
  the approval gate but was merged from the **project** level just like `deny`, in both
  `.mipham/settings.json` and `.mipham/config.yml` — so cloning a repository was equivalent to
  clicking "don't ask again" on the operator's behalf. The mode ceiling does not save you here:
  `allowRuleDecision` returns `bypass` outright when `maxAllowedMode` is absent, and absent is the
  default configuration. The criterion is now **direction, not key name**: both doors accept only
  `deny`. Consequently `/permissions allow` now always writes the **user** level, and `remove` looks
  in both.
- Security: `Config set providers.<x>.apiKey` no longer writes plaintext. The read side already
  treated `enc:v1:` as the at-rest form; the same file had two writers, only one of which encrypted.
  The fix reuses the existing `encryptApiKey` rather than restating what counts as a secret, adds an
  idempotence guard (double-encryption is silent), writes atomically with mode 0600, and never echoes
  the key back.
- Security: the `Config` tool no longer returns `config.yml` verbatim. That file holds credentials
  (`apiKey`, MCP `env`/`headers`, the inference-hook `signing_secret`). The harm is not that the file
  is read on disk but that this output **enters the model context and session log** and travels to the
  provider on every subsequent request. Of five credential-adjacent tools it was the only one whose
  output passed through no masking at all. The fix reuses `maskOutput` instead of writing a second
  definition of "what counts as a secret".
- Security: project-level `permissionRestrictions` only narrows now. `forbiddenModes` nominally only
  forbids modes, but the fallback walks **downward** from the requested mode and, if that mode and
  everything below it is forbidden, lands on `allowed[0]` — a **wider** mode. Forbidding the
  narrowest mode, `plan`, produces exactly that: requesting `plan` silently yields `default`,
  `acceptEdits` or `auto`. Measured over the full input space (32 forbidden subsets × 5 requested
  modes = 160 cells), the 27 widening cells fall **entirely** inside the 16 subsets containing `plan`.
  The widening entry is now withheld and reported.
- Security: `/feishu/event` is rate-limited before all routes now, and its body is capped at 256 KiB
  before parsing. Re-checking the finding showed one of its sub-claims was **false**: the route's gate
  was always the Lark signature (unsigned and forged-signature events both get 400
  `invalid_signature` and are never delivered), so it was a **control** bypass, not an **auth**
  bypass. What held was **billing** (the callback returned before the origin gate and the rate limiter
  — a signature answers "should this be processed", never "how many times may it arrive") and **unit
  cost** (Bun's default request body limit is 128 MB, and the adapter used to `await request.json()`
  directly).
- Security: the daemon token read path gained a type gate and a mode repair. A FIFO with no writer
  used to make the token loader hang **synchronously** (killed by the watchdog, no error output);
  the same shape on the key path throws a named error within seconds. A non-regular file now throws a
  **named error** and is never treated as "absent" — treating it as absent would rename it away and
  mint a new token, locking out already-paired clients. The mode target is this module's own declared
  `0o600`, and the repair is reported. The same commit folds `mipham attach`'s inlined third copy of
  the read onto the single reader (3 readers → 1).
- Fixed: when the process starts in `~`, the user's own configuration was stripped as if the
  **repository** had declared it. `MIPHAM_HOME` is `join(homedir(), '.mipham')` while the
  "project-level" path is `join(cwd, MIPHAM_DIR, X)`; when `cwd === ~` the two are byte-identical, so
  every "read project level" guard was reading the user's own file — discarding settings the user wrote
  by hand as if the repo had granted them, **and then naming that same file** in the warning. The fix
  is a predicate whose criterion is "are these two paths the same directory", not "is it under home".
- Fixed: the CRSI always-on lesson block now has a character budget, so `critical` can no longer grow
  without bound. The shape is **a per-item predicate carrying a whole-tier property**: `severity` says
  whether one lesson qualifies to stay resident, while the size of the block is a property of the tier
  — so nothing could ever say "this tier is too big". The budget is 3,000 characters, allocated by
  rendered character count (single lessons differ threefold in length), and lessons pushed out by the
  budget are **not discarded**: they move into the pointer and are named there, because silently
  vanishing and never having been written look identical from the outside.
- Fixed: a `--crossover` merge no longer silently promotes `warning` lessons into the resident tier.
  The merge contract never mentioned `severity`, so the model had no way to preserve it and the
  builder fell back to the extractor's fail-open tier (unknown ⇒ `critical` ⇒ resident). Severity is
  now derived deterministically from the two sources (the stricter one wins), and it became a
  **required parameter**, turning "the caller forgot" from a silent behaviour change into a compile
  error. The merge receipt reports the shift, presenting only — never judging — and always prints it,
  including "no promotion", since that is the falsifiable baseline.
- Fixed: the instruction-payload size guard now measures with the same ruler as the startup warning.
  The old guard measured **one file's character count on disk** while the warning measured **all the
  text the loader actually splices into the system prompt** — two unrelated rulers, so "guard green"
  and "warning firing" could both be true. The new ruler reads the loader's own report and shares one
  constant with the warning. It deliberately measures **only this repository's own share**: the total
  includes org-level files that this repository's commits cannot change and that do not exist in a CI
  checkout, so judging on the total would be red locally and green in CI.
- Fixed: the three-part separator in the skill-selection prompt was being eaten by `.filter(Boolean)`.
  Three sections were joined with intentional blank-line separators and the trailing `.filter(Boolean)`
  could not tell those apart from a genuinely empty conditional line, so the prompt that actually
  reached the model contained **no blank line at all**. A sibling function sixteen lines below used the
  correct `...(cond ? [x] : [])` form. The prompt is a versioned resource, so its version was bumped.

## 0.85.8 (2026-09-28)

- Version sync with Mipham Code CLI 0.85.8
- Added: CRSI lessons are now tiered by severity, and the always-on block drops from 11,743 to
  2,296 characters (−80.4%). Each lesson carries `- 严重度: critical|warning`: the 6 `critical` ones
  stay resident, the 33 `warning` ones leave the always-on block and leave behind a one-line
  pointer to the lessons file's **absolute path**, which the model reads on demand with its
  existing Read/Grep — no new command, no new mechanism. A missing or out-of-set severity falls
  back to `critical` (fail-open to resident): better to spend characters than to silently downgrade
  a guard into "written but never read". The extractor now accumulates by `##` block and flushes at
  the block boundary (`- 严重度:` sits after `- 建议:`, which the old "push on seeing 建议" logic
  never read). `buildSystemPrompt` and `sizeReport` now share one `crsiLessonsText()` projection —
  what the report describes has to be what gets sent.
- Added: the `--prose` operator that rewrites skill prose now actually receives the lessons. The
  root cause was **absence**: the main agent's system prompt carried the always-on lessons, while
  the operator that rewrites skill prose — the prose the main agent then has to obey — got
  `systemPrompt: ''` plus a single user message. `loadAlwaysOnLessonsBlock()` is the block's second
  projection, same source but deliberately **without** the pointer (this operator is a tool-less
  single `llm.chat` message, so a pointer is worth nothing to it). `lessonsBlock` is a **required**
  5th parameter, turning "the caller forgot" from a silent behaviour change into a compile error.
  `PROSE_GENERATE_PROMPT_VERSION` 1.1.0 → 1.2.0. Skill selection deliberately does **not** inject
  (it only picks a path; lessons are noise there).
- Added: `/crsi propose --prose` now prints the net change. It lands right next to the diff it
  describes, present-not-judge (labelled "not judged"). Deliberately unlike the risk line beside
  it, this one prints **always, including zero** — zero is the falsifiable "it did not grow"
  reading, and printing only non-zero hides the baseline. The line-count definition is pinned
  (newline count + 1 when the tail is non-empty without a trailing newline), otherwise the number
  is not falsifiable. The prediction, risk, and net-change lines all end with a newline now —
  without it the operation hint was glued onto the tail of the last content line.
- Fixed: **no cursor on empty input — and empty input is the state you see most.** The white block
  lived only in the `else` branch of the placeholder ternary, while `value.length === 0 &&
placeholder` holds in real use (the placeholder is a localised hint or a loading verb, never an
  empty string), so the initial state had no cursor at all. Both branches now draw it. The block
  also moved from `inverse` to **explicit white** (`backgroundColor="white"` + black text): inverse
  reads the terminal's _foreground_ colour, so a theme change makes it something else entirely,
  whereas "an upright white rectangle" is a fixed shape requirement.
- Fixed: CRSI's `risk` was carried through three layers with **zero readers.** `risk` and
  `expectedEffect` (ε) come from the same line of JSON and the same prompt, but ε reaches the
  ledger and is read back by `predictionHitRate` while `risk` lived only in memory —
  `CrsiModification` has no such field, so it never even reached the sandbox. That is the same
  external reading as "the field does not exist". It now lands where a human actually decides: the
  `/crsi propose --prose` receipt, right next to the diff it describes, present-not-judge, and
  always carrying "**unverified**" — otherwise the line would imply the risk had been handled
  (a key that reacts while the world stays the same is worse than a key that does not exist). If
  the risk is absent the whole line is omitted, rather than printed empty.
- Fixed: the eval gate recorded "could not judge" as "judged it bad." `evaluate()` sat bare on an
  `await`, so a throw escaped the function and the worktree created by `createWorktree` was never
  reclaimed; the caller got an exception instead of a verdict, and a truncated report was treated
  as regression. The instrument now proves itself first (`instrumentFailure`): an **empty contract
  set is always a fault** — in that case the formula yields **exactly 100**
  (`results.length > 0 ? … : 100`), so "couldn't judge" and "judged it perfect" are the same
  external reading; only a count **below the declared floor** counts as shrinkage. The gate now
  rolls back and says so explicitly ("Harness unavailable … **did not judge the change itself**").
  The floor is declared by the battery's owner (`RewardFn.minContracts`) rather than imposed on
  pluggable third-party reward sources — otherwise "it simply reports fewer" would be misread as an
  instrument fault (the first draft of this check really did flag an existing 2-contract test
  double as a fault, which is why it has to be split in two). And when the change passes the gate
  but the anchor gate was not applied, that is now named: there are **five** success branches, and
  hand-writing four of them missed the `--prose` one — so it is a shared renderer plus a
  **range-property guard** (a `renderGateNote(` must appear between each call site and the next),
  not a head-count.

## 0.85.7 (2026-09-27)

- Version sync with Mipham Code CLI 0.85.7
- Fixed: `/rewind` was broken in both halves — the rewind never reached the log, and the screen went
  blank afterwards. `/rewind` rewrites the **whole** projection, but it recorded no event and did
  not redraw. On the log side, the log is the **only** source `--resume` / `/resume` rebuild history
  from, so without an event the rewound turn came back on the next resume. The "model-visible means
  logged" invariant is held by an assertion that does **prefix matching** — a rewind rewrites the
  whole content, which lands outside that match, so the assertion never fired. A `rewind` event type
  now exists with the same projection semantics as a compaction rewrite (whole-snapshot replacement)
  but deliberately **not merged into the same type**: merging would make "which turns in this log
  have been summarized" answer wrongly. On the command side, the command returned only
  `clearMessages: true` — the shape of `/clear` — but a rewind is different: the history up to that
  point still counts, only the copy on screen is stale. Without forwarding the messages the list was
  emptied with **no path to refill it**: the model could see the rewound history while the user saw
  nothing
- Fixed: the two read-time-derived sections of the system prompt never entered the context estimate.
  The context manager used an incremental accumulator, while two prompt sections are derived at read
  time — the permission-mode section reads the permission system's current mode, the MCP section
  reads the instructions of connected servers. Their application points are live closures wired up at
  startup, so **the change points are not inside that class**: MCP servers connect asynchronously
  after startup (after any prompt was set) and the permission mode toggles whenever the user cycles
  it. Neither section ever entered the estimate, so a per-server block capped at 2000 characters did
  not exist as far as this session was concerned. This was not "a missing recompute point" but a road
  that **cannot work**: the caller cannot enumerate the full set of change points, and missing one
  leaves the estimate permanently low ⇒ compression triggers late. It is now derived at read time —
  messages stay accumulated, the prompt is assembled and counted at the moment it is read, and the
  two are summed. Three same-root cleanups came with it: setting the prompt no longer recomputes (the
  old contract "a recompute must include the messages" was held only by a comment); the estimate
  stored in snapshots is gone and is recomputed from the just-restored messages (a stored number is a
  second copy of the same fact and drifts from the messages independently); and `reEstimateTokens()`
  was renamed to `recountMessageTokens()` — the old name promised more than it did
- Fixed: the `/tasks` panel called itself "Background tasks" while never reading the task registry.
  Its name, title and empty state are all **registry** vocabulary, but its predicate was always
  history — counting task tool-call blocks in the messages. The two can disagree, and **both
  directions are wrong**: after history compaction the tool blocks are gone while the tasks remain ⇒
  the panel says "no tasks tracked yet" when tasks exist; with no tasks but history present it says
  "N task operations detected". And "how many calls have I seen" never answered the question the
  panel exists to answer — which tasks exist now. The real registry was one call away (the goal
  progress panel already consumed it; `/tasks` was the only reader never wired up) ⇒ the list
  renderer was extracted verbatim as `formatTaskList()` — one renderer, two readers. The i18n key
  cleanup that followed from it went in the same change
- Fixed: a workflow's provider override said "switch temporarily" and never restored anything. The
  comment read "switch temporarily" while the code switched the provider and walked on — the
  function had no restore point at all. The registry's active provider is **session-level**: the
  sub-agent reads it while executing and routes through it when there is no override, and the engine
  footer and the `/model` panel read it too ⇒ one agent call with a provider override inside a
  workflow moved the whole machine's session there and never moved it back, when the override's scope
  should have been that one call. The restore now sits as the **first** statement of the existing
  `finally` (the worktree cleanup below it spawns git and can itself throw — putting it after would
  mean "restore only when cleanup went well", which is exactly the case that least needs restoring),
  and the switch itself moved to the **first** statement of the existing `try` (the worktree setup
  above it can throw, and a throw before the switch should not find us already switched)
- Fixed: ignored project-level telemetry keys are no longer silence. The project-level telemetry
  block was only half-used: a veto took effect, while `enabled: true` and `endpoint` were read and
  then dropped. **Dropping them is right** — honouring `endpoint` would mean that cloning a
  repository reroutes a user's already opted-in telemetry to a collector that repository names, which
  is the same thing as "a project cannot grant consent", written a second way. What was missing was
  not adoption but **telling the user**: from the outside, "deliberately not adopted" and "your file
  was never read" are the same silence — and this is text the user wrote, in a file they can still
  open. A list of ignored keys now comes back with the consent result and is announced once on
  stderr where it is resolved (the only place that knows something was blocked, which also covers
  non-interactive paths); `/telemetry status` gained a line that appears **only when there is
  content** — a permanent "(none)" row is noise. The hard-off early path returns an empty list and
  **does not read the file**, because reporting a declaration that was never read is a false statement
- Fixed: the model picker's panel switch was not read in the same tick as the cursors. Its active
  panel came from a render closure, while the panel and the cursors are judged **together within one
  keypress**: Tab decides which panel, the arrow keys decide which panel's cursor moves, and Enter
  decides which confirmation path runs (on the provider panel it switches provider; only on the model
  panel does it confirm a selection). Reading the panel from the closure alone made those three
  resolve against the tick **before** the switch ⇒ the arrow key moved the provider cursor and Enter
  took the provider path ⇒ **nothing was ever selected**. It now reads through the same key channel as
  the two cursors. A sibling panel was deliberately **not** migrated, with the reasoning written into
  the comment: its keys are all ordinary characters, and a single chunk carrying `j` and a carriage
  return is measurably **one** event ⇒ the symptom is "nothing happened this tick" rather than "acted
  on the previous row", so migrating without a reproducible failure would only make the test green
  before and after

## 0.85.6 (2026-09-26)

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

## 0.85.5 (2026-09-25)

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
