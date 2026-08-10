---
name: triage
description: Structured task decomposition and tracking across sessions. Use for breaking complex plans into trackable tickets with dependency graphs, checking task status, or continuing work from a previous session.
version: 1.0.0
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
---

# Triage — Cross-Session Task Tracking

Turn plans into trackable tickets with dependency management. Inspired by Matt Pocock's `triage` + `to-tickets` + `wayfinder` skills, consolidated into one Mipham Code skill.

## When to Use

- Breaking a large plan into actionable tickets
- Tracking work across multiple sessions
- User asks: "what's next?", "where did I leave off?", "what's the status?"
- Complex tasks with dependencies between them

---

## The Ticket Format

Tickets live in `.mipham/tickets/` as individual Markdown files:

```markdown
---
id: T-001
title: Add user authentication
status: in-progress
priority: P0
depends_on: []
blocks: [T-003]
created: 2026-08-10
tags:
  - auth
  - backend
---

## Description

Add JWT-based authentication with refresh token rotation.

## Acceptance Criteria

- [ ] Login endpoint returns access + refresh tokens
- [ ] Refresh endpoint rotates tokens
- [ ] Invalid tokens return 401
- [ ] Rate limiting on login attempts

## Notes

- OAuth not in scope for T-001 (punted to T-005)
```

### Status Values

| Status        | Meaning                                    |
| ------------- | ------------------------------------------ |
| `backlog`     | Not yet planned for any session            |
| `planned`     | Scoped and ready to work                   |
| `in-progress` | Currently being worked on                  |
| `review`      | Implementation done, awaiting verification |
| `done`        | Verified and merged                        |
| `blocked`     | Cannot proceed due to dependency           |
| `wontfix`     | Decided not to do                          |

---

## The Triage Workflow

### Phase 1: Decompose (Plan → Tickets)

Given a plan or feature request:

1. **Identify the smallest independently-valuable units of work**
   - Each ticket should deliver value on its own
   - If a ticket requires 3+ files touched, it's probably too big
   - If a ticket can be done in < 15 minutes, it's probably too small

2. **Map dependencies**
   - What must be done first? (hard dependency)
   - What would be easier after something else? (soft dependency)
   - What blocks other work? (reverse dependency)

3. **Assign priorities**
   - **P0**: Blocks other work, must do first
   - **P1**: High value, should do soon
   - **P2**: Nice to have, can defer
   - **P3**: Optional, do if time permits

4. **Write acceptance criteria**
   - Specific, testable, unambiguous
   - "Login works" is bad. "POST /auth/login with valid credentials returns 200 + JWT" is good.

### Phase 2: Status Check

When the user asks "what's next?" or "what's the status?":

1. Read `.mipham/tickets/` directory
2. Report:
   - Currently in-progress tickets
   - Blocked tickets (and what's blocking them)
   - Next unblocked P0/P1 tickets ready to work
   - Recently completed tickets (for context)

### Phase 3: Session Handoff

When starting a new session, check for continuity:

1. Read the previous session's context from the session store
2. Check ticket statuses — any that were `in-progress` last session?
3. Present: "Last session you were working on T-004 (Add rate limiting). Continue from there, or start on T-007 (API docs) which is next in the P1 queue?"

### Phase 4: Ticket Lifecycle

When working on a ticket:

- Mark it `in-progress` when you start
- Mark it `review` when implementation is done
- Mark it `done` after verification (tests pass, typecheck clean)
- If you discover new dependencies, add them to `blocks`/`depends_on`

---

## Dependency Graph

For tickets with complex dependencies, generate a visual summary:

```
T-001 (Auth) ──blocks──→ T-003 (Dashboard)
    │                        │
    └──blocks──→ T-002 (API) ─┘
                     │
                     └──soft-dep──→ T-004 (Rate Limiting)

Ready to work: T-001 (no dependencies)
Blocked: T-002 (waiting on T-001), T-003 (waiting on T-001, T-002)
```

---

## Integration With Mipham Code

- **Session Store**: Ticket status persists across sessions via `.mipham/tickets/`
- **Memory System**: Active tickets are loaded as project memory for context
- **grill-with-docs**: The output of a grill session feeds directly into ticket decomposition
- **Background Agents**: Long-running work on a ticket can be spawned as a background agent
- **Critical Thinking Layer**: When decomposing, ask "what's the smallest thing that delivers value?" — don't over-decompose
