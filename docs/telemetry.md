# Telemetry and crash reporting

Mipham Code can report **anonymous usage counts** and **crash summaries** — the
type, depth and message digest of a crash, never its stack. This page is the full
data dictionary: it lists every field the CLI can send, and the things it promises
never to send.

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
`/telemetry endpoint <url>`. First match wins; when none of them is set the CLI
uses the official receiver, **`https://log.onemipham.com/v1/events`**.

`/telemetry endpoint none` means _nowhere_: telemetry stays on and keeps
recording locally, but nothing ever leaves the machine. An empty value does not
do this — being falsy it falls through to the next tier, which is why the
sentinel exists. `/telemetry status` reports which tier supplied the
destination.

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

Label cardinality is bounded, but not the same way on both sides. `tool_calls`
is closed by construction — there are only as many tool names as the tool
registry declares. `command_calls` is **not**: that name is whatever the user
typed, so anything unrecognised is collapsed to `/unknown` before it is counted.
Counts are plain integers; nothing is per-user and nothing is per-event.

## The `crash` event

Sent when a session recorded a crash.

| Field           | Type     | Notes                                                           |
| --------------- | -------- | --------------------------------------------------------------- |
| `installId`     | uuid     | Same id as above                                                |
| `schemaVersion` | int      |                                                                 |
| `occurredAt`    | ISO 8601 |                                                                 |
| `appVersion`    | string   |                                                                 |
| `runtime`       | string   |                                                                 |
| `platform`      | string   |                                                                 |
| `errorName`     | string   | e.g. `TypeError`                                                |
| `messageHash`   | string   | SHA-256 of the message, first 16 hex chars — **never the text** |
| `frameCount`    | number   | How many frames the stack had                                   |
| `origin`        | string   | `uncaughtException`, `unhandledRejection`, or `render`          |

Only a digest of the error message is sent, because messages routinely embed
paths and user data.

### Why there are no stack frames

Schema v1 sent `stackFrames` — redacted, first 15 — and the receiver threw them
away on arrival: "dimensional aggregates only" leaves a frame string nowhere to
live. Sending them bought ~3 KB per crash of transfer and a privacy surface in
exchange for nothing, so **v2 stopped sending them**.

A crash report can therefore tell you the crash type, its depth, and how many
installations hit it — **never which line it happened on**. Locating a stack
would need a separate, explicitly consented channel; it is not this one.

The frames are still redacted, but they stay in the process's memory for the
session and are never written to disk or sent. Redaction: the current working
directory becomes `<cwd>`, your home directory becomes `~`, and the first path
segment under home is collapsed to `<dir>` — so a frame under home but outside
the project cannot disclose the project's name. Line and column numbers are kept,
because a stack without them cannot be acted on.

`frameCount` stays, so that "this stack was short" remains distinguishable from
"this stack was cut".

> The receiver still accepts the v1 format, because v1 clients are installed and
> cannot be recalled. Their frames are counted (`framesDiscarded`) and dropped —
> the count is the receipt that they were sent and not kept.

### Crashes are caught even when telemetry is off

The crash handlers are installed unconditionally: they are what stops a crash
from becoming a silent hang. When telemetry is off, the record stays on your
machine and is never uploaded.

## What the receiver keeps

The official receiver (`https://log.onemipham.com/v1/events`) is **public and
write-only**: the CLI carries no credential — it cannot, since the client is
published to npm — and there is no read endpoint. What it can do with an event is
therefore deliberately narrow:

- **Dimensional aggregates only**, partitioned by the **day the server received
  it** (UTC). The client's `occurredAt` is never used as a partition key: an
  unvalidated timestamp is an unbounded dimension, so it only becomes an offset
  bucket.
- **No free text at all.** Counter labels are matched against a server-side
  allowlist; anything unrecognised is folded into `__other__` and the original
  label is not written anywhere. An allowlist rather than a numeric cap, because
  the endpoint is unauthenticated: a cap can be _filled_ with junk, which would
  push real labels out of their own buckets.
- **No install ids.** `installId` feeds a HyperLogLog sketch and is never
  persisted — a plain set would itself be the day's install list.
- **No stack frames** — see the note above.
- **No read path at all**, not even an authenticated one. Reading is the offline
  `report` command; a read endpoint would expose far more than a write endpoint
  can.

Two consequences worth knowing:

- **A `204` does not mean persisted.** The receiver flushes every 25 accepted
  events or every 10 seconds, so a kill in that window loses the increment. A
  crash _before_ the 204 leaves the client's queue intact and the event is
  resent; the narrower window — acked, then killed before the flush — is the one
  that actually loses data.
- Aggregates live under `/var/lib/mipham-telemetry`, encrypted at rest
  (AES-256-GCM, key in `/etc/mipham-telemetry/aggregate.key`). **Losing that key
  makes every day's file unreadable** — it is not derivable from anything else.

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
