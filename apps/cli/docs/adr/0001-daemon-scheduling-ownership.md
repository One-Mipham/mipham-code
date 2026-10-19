# 0001 — Scheduler ownership: which scheduling surface owns which runtime

- **Status**: Accepted (short-term), with an open unification decision
- **Date**: 2026-10-19

## Context

Three scheduling mechanisms exist, and they do not share a store, a poller, or a
delivery path:

| Surface                                          | Store                                              | Fires via                                                | Drives                                                    |
| ------------------------------------------------ | -------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| `ScheduleWakeup` (tool)                          | `~/.mipham/wakeups/<sha256>.json`, one per session | in-process `setTimeout`, or `resumeWakeups()` on restart | `QueryEngine.enqueueWakeup` → drained by `ui/app.tsx`     |
| `CronCreate` / `CronList` / `CronDelete` (tools) | `~/.mipham/cron/*.json`, cwd-scoped                | `startCronPoller()` every minute                         | `QueryEngine.enqueueCronPrompt` → drained by `ui/app.tsx` |
| `ScheduleManager` (daemon only)                  | daemon SQLite `schedules` table, per session       | `checkAndFire()` every minute                            | `SessionWorker.processPrompt`                             |

The interactive CLI starts the cron poller and calls `resumeWakeups` in
`ui/app.tsx`. The daemon starts `ScheduleManager` in `daemon/index.ts`, and its
engines are built from the full `createToolRegistry()` — so a daemon session can
call `ScheduleWakeup` and `CronCreate` too, but **nothing in the daemon drains
the queues those tools fill**. The persisted wakeup file stays on disk; nothing
re-arms it, and an expired one is never reported.

The first half of this problem surfaced as a real defect: the wakeup handler was
a module-level singleton, and the daemon builds one engine per session in a
single process. Each engine construction overwrote the previous handler, so a
timer armed for session A called the engine built last — session A's loop prompt
landed in session B. Fixed by keying handlers by session
(`tools/scheduling/schedule-wakeup.ts`, `core/engine.ts`) and unregistering on
session close (`daemon/server.ts`).

That fix makes delivery correct **where delivery exists**. It does not give the
daemon a consumer.

## Decision

**Short term (accepted, partially implemented):**

1. Wakeup handlers are per-session, and an engine moves its registration on
   `setSessionId`. A closed daemon session drops its handler and pending timer.
2. `ScheduleWakeup` and `CronCreate` remain **interactive-CLI features**. The
   daemon must not silently accept them. The next step is an explicit refusal
   when the tool is called from a daemon-hosted session, or removal of both
   tools from the daemon's registry. A tool that reports "scheduled" while no
   consumer exists is worse than a tool that is absent: the model acts on a
   promise the runtime will not keep.
3. `ScheduleManager` remains the daemon's scheduler. It already scopes jobs to a
   session and delivers through `SessionWorker`, which is what the daemon has.

**Target (open):** one scheduler. Either

- **A. Unify on the daemon model** — give the daemon an API/tool surface over
  `ScheduleManager`, and teach the CLI to talk to it; or
- **B. Unify on the file-backed model** — the daemon runs the same cron poller
  and wakeup resume path, with delivery routed to the owning session's worker.

Both require a delivery abstraction the engines already almost have
(`enqueueWakeup` / `enqueueCronPrompt` are the queue; the missing piece is one
consumer per runtime). Choose when daemon-native scheduling has a product owner;
until then option B of the short-term decision is the guard.

## Consequences

- A daemon session cannot be promised a wakeup. Saying so explicitly is the
  point; the alternative is a silent no-op that looks like success.
- The CLI keeps its two stores. They are persisted files, which is what lets a
  wakeup survive a restart — a property the SQLite scheduler would have to
  re-earn if it replaced them.
- `WorkerPool.stopWorker` recycling an idle worker currently leaves the engine
  in `engineCache` and the timer alive; the wakeup fires into a queue no one
  drains. This is the same missing-consumer gap and is not fixed by the
  singleton repair.
- If the daemon is given a consumer later, the per-session handler registry is
  already the shape the router needs: one entry per session, no shared slot.
