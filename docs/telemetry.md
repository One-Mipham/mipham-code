# Telemetry and crash reporting

Mipham Code can report **anonymous usage counts** and **redacted crash stacks**.
This page is the full data dictionary: it lists every field the CLI can send, and
the things it promises never to send.

**Telemetry is off unless you turn it on.** With it off, no counters leave the
process, no queue file is created, and no request is made.

## Turning it on and off

| How                       | Effect                                                 |
| ------------------------- | ------------------------------------------------------ |
| First interactive launch  | A single one-time question. Answered once, per machine |
| `/telemetry on`           | Enable, effective immediately and persistently         |
| `/telemetry off`          | Disable                                                |
| `/telemetry status`       | Show the current state and what decided it             |
| `/telemetry reset-id`     | Replace the anonymous install id                       |
| `/telemetry endpoint <u>` | Point reporting at your own collector                  |

The answer lives in `~/.mipham/settings.json` under the `telemetry` key. It is
never written to `config.yml`.

### Why there is no prompt in scripts and CI

The question is only asked when there is a terminal to answer on. Under a pipe,
a daemon or CI the CLI stays opted out **and does not record that it asked** — so
the first interactive launch still offers the choice.

### The three-tier decision

1. `MIPHAM_TELEMETRY=off` — hard off. Overrides everything: nothing is
   collected, no queue file is written, no request is made.
2. `~/.mipham/settings.json` → `telemetry.enabled` — your own consent. Only
   `true` counts; the default is off.
3. `<project>/.mipham/settings.json` → `telemetry.enabled` — **veto only**.

Tier 3 is deliberately asymmetric: a project may switch telemetry _off_ but never
_on_, so cloning a repository can never amount to that repository consenting on
your behalf. There is no environment variable that grants consent — the granting
must be a deliberate, persistent act.

### Endpoint

`MIPHAM_TELEMETRY_ENDPOINT`, or `telemetry.endpoint` in settings, or
`/telemetry endpoint <url>`. **It ships empty.** With no endpoint configured the
CLI still records locally but sends nothing, ever.

## When data moves

Collecting and sending are separate steps:

| Moment       | What happens                                                              |
| ------------ | ------------------------------------------------------------------------- |
| During a run | Counters accumulate in memory. No I/O                                     |
| At exit      | Synchronously: the whitelisted counters plus session metadata are queued  |
| Next launch  | The queue is drained in the background. Success deletes; failure keeps it |

Exit cannot wait for the network, so nothing is ever sent while the CLI is
shutting down. A queue left behind is drained on the next launch.

## The `session` event

One per CLI launch, formed at exit.

| Field               | Type                     | Notes                                                     |
| ------------------- | ------------------------ | --------------------------------------------------------- |
| `installId`         | uuid                     | Generated on first use; `/telemetry reset-id` replaces it |
| `schemaVersion`     | int                      | Payload revision, so an endpoint can evolve               |
| `occurredAt`        | ISO 8601                 | When the event was formed                                 |
| `appVersion`        | string                   | e.g. `0.81.6`                                             |
| `runtime`           | string                   | `bun@1.2` or `node@22`                                    |
| `platform`          | string                   | `darwin/arm64`, `linux/x64`, …                            |
| `sessionDurationMs` | number                   |                                                           |
| `crashed`           | boolean                  | Whether this session recorded a crash                     |
| `counters`          | `Record<string, number>` | The whitelisted counters — see below                      |

### The install id is not an identity

It is a bare random UUID. It is not derived from, and not joined to, any account,
machine fingerprint, hostname, MAC address or file. It exists so that repeated
sessions from one installation can be recognised as repeats rather than as
different users, and it can be replaced at any time.

### `counters` is a whitelist, not a dump

Only these counter families are ever uploaded. A whole-registry dump would
silently enrol every counter added in future, and a future counter's labels may
carry data this page promises not to send.

| Key in payload           | Source counter                             | Reported as       |
| ------------------------ | ------------------------------------------ | ----------------- |
| `cli_invocations`        | `mipham_code_cli_invocations_total`        | total             |
| `command_calls.<name>`   | `mipham_code_command_calls_total`          | per slash command |
| `tool_calls.<name>`      | `mipham_code_tool_calls_total`             | per tool          |
| `crsi_rule_applications` | `mipham_code_crsi_rule_applications_total` | total             |
| `sis_interceptions`      | `mipham_code_sis_interceptions_total`      | total             |

Label cardinality is bounded by construction — there are only as many command
names as the CLI ships and as many tool names as the registry declares. Counts
are plain integers; nothing is per-user and nothing is per-event.

## The `crash` event

Sent when a session recorded a crash. The stack is **redacted and truncated**.

| Field           | Type       | Notes                                                           |
| --------------- | ---------- | --------------------------------------------------------------- |
| `installId`     | uuid       | Same id as above                                                |
| `schemaVersion` | int        |                                                                 |
| `occurredAt`    | ISO 8601   |                                                                 |
| `appVersion`    | string     |                                                                 |
| `runtime`       | string     |                                                                 |
| `platform`      | string     |                                                                 |
| `errorName`     | string     | e.g. `TypeError`                                                |
| `messageHash`   | string     | SHA-256 of the message, first 16 hex chars — **never the text** |
| `stackFrames`   | `string[]` | Redacted, first 15 frames                                       |
| `frameCount`    | number     | Total frames _before_ truncation                                |
| `origin`        | string     | `uncaughtException`, `unhandledRejection`, or `render`          |

Only a digest of the error message is sent, because messages routinely embed
paths and user data. `frameCount` is reported alongside the truncated frames so
that "this stack was short" stays distinguishable from "this stack was cut".

Redaction, applied to every frame: the current working directory becomes
`<cwd>`, your home directory becomes `~`, and the first path segment under home is
collapsed to `<dir>` — so a frame under home but outside the project cannot
disclose the project's name. Line and column numbers are kept, because a stack
without them cannot be acted on.

### Crashes are caught even when telemetry is off

The crash handlers are installed unconditionally: they are what stops a crash
from becoming a silent hang. When telemetry is off, the record stays on your
machine and is never uploaded.

## What is never collected

- Conversation content, prompts, or completions
- File contents, file paths in plain text, project names, user names, hostnames
- API keys, tokens, credentials, or the value of any environment variable
- MCP server addresses, provider configuration, or model output

## Local files

| Path                              | Contents                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `~/.mipham/telemetry/queue.jsonl` | Pending events. Written `0600`, at most 100 entries; the oldest are dropped first |
| `~/.mipham/settings.json`         | Your `telemetry` answer, endpoint, and install id                                 |

## Related

- Roadmap and status: [`ROADMAP.md`](../ROADMAP.md)
- Reference implementation: [`apps/cli/src/telemetry/`](../apps/cli/src/telemetry/)
