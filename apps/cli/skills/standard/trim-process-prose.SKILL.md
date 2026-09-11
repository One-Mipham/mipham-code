---
name: trim-process-prose
description: Use when cleaning process-perspective narration an AI left in code, comments, docs, or commit messages — "originally A, changed to B", design-decision references, or review back-and-forth a reader with only the current checkout cannot independently parse or verify
version: 1.0.0
---

# Trim Process Prose

Agents leave their working perspective in the repo — "initially we used A, then the reviewer wanted B", "decision 7", "for now, fix later" — which only makes sense inside the session that produced it. Months later a maintainer has only the checkout, not the chat, the PR thread, or the task plan. That residue is process prose.

## The test

For any sentence a change adds — a comment, a doc line, a commit-message clause — ask:

> **Can a reader holding only the current HEAD checkout independently parse and verify this?**

- **Yes** → keep it.
- **No** → keep the durable fact, drop the process.

The fact is what a future maintainer needs; the process is how you got there, and it dies with the session.

## What to keep vs drop

| Keep (durable)                                                                          | Drop (process)                                                             |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Why B is _required_: "B is used here because A leaks resources under concurrent cancel" | How you chose it: "initially A, then reviewer preferred B"                 |
| A contract/invariant: "this must hold or X breaks"                                      | A reference a HEAD reader can't resolve: "decision 7", "C2", "design §4.7" |
| A precondition/postcondition the next editor must respect                               | A status marker: "for now", "v3 will handle this", "TODO after PR"         |
| A compatibility promise                                                                 | A review trace: "reviewer confirmed", "per discussion"                     |

## Rewrite, don't annotate

```diff
- // originally plan A had a race; reviewer asked for B; switching to B
+ // B: plan A could not guarantee resource release under concurrent cancel
```

The second line is the only thing the next maintainer needs. The first line is archaeology.

## When NOT to touch

- A sentence that already passes the HEAD-reader test — do not strip facts to be tidy.
- A working session in progress — trim at commit/push time, not while reasoning.
- `docs/truth/**` claims that cite `file:line` — those are evidence, not process.

## Red flags

- "This context is useful" — useful to _you now_; the test is the HEAD reader, not you.
- Keeping "originally X / changed to Y" — the change is already visible in the diff; the narration is redundant.
- Leaving a task-plan reference the reader can't resolve — that is the exact leakage to remove.
