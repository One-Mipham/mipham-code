---
name: doc-sync
description: Keep engineering truth docs aligned with code — map changed code to docs, update stale docs after functional changes, keep git-reviewable
version: 1.0.0
---

# Doc Sync

Keep engineering "truth docs" aligned with code. After a functional code change, run this skill to find the docs that map to the changed code, check them against the code + tests, and update anything that drifted. Docs travel with the branch in git and are reviewed alongside the code diff.

## Where truth docs live

Engineering truth docs live under `docs/truth/engineering/`. Routing from code → docs lives in `docs/truth/ROUTES.md`.

```
docs/truth/
├── ROUTES.md            # code area → canonical doc mapping
└── engineering/
    ├── behaviors/       # implementation behavior
    ├── contracts/       # API / interface contracts
    ├── architecture/    # component structure and boundaries
    ├── workflows/       # multi-step flows and orchestration
    └── operations/      # runbooks, config, deployment
```

## Invariants (never break)

- **Doc-only**: touch `docs/truth/**` and `ROUTES.md` only. Never modify functional code, tests, or config outside `docs/truth/`.
- **Evidence-backed**: every claim cites `file:line` (or `file` for a whole file). No invented behavior.
- **Branch-scoped**: docs change in the same branch as the code, so they review together.

## Workflow

### 1. Map — find the docs that cover the change

Determine the changed code. Prefer an explicit path argument; otherwise use the working-tree or branch diff:

```bash
git diff --name-only            # uncommitted working-tree changes
git diff --name-only HEAD~1     # last commit
```

Read `docs/truth/ROUTES.md` and match the changed paths to their canonical doc. A route is a glob → doc path pair. A changed path with no route is a signal to create one (Step 3).

### 2. Check — is the doc now stale?

For each mapped doc, read the doc, the changed code, and the relevant tests. Compare:

- Does the doc describe behavior the code no longer has?
- Does the code add or remove behavior the doc doesn't mention?
- Do contract shapes (signatures, types, errors) still match?
- Are the `file:line` evidence pointers still valid?

A doc is stale when any claim no longer matches the code + tests.

### 3. Update — fix the drift

- **Existing doc, stale**: edit the doc in place. Update claims, refresh `file:line` pointers, remove dead behavior, add new behavior. Keep the section structure unless the change demands otherwise.
- **Existing doc, orphaned**: if the mapped code is gone, remove the doc and its route entry.
- **Changed path has no route**: create one bounded doc under the right `docs/truth/engineering/<type>/` folder and add a route entry to `ROUTES.md`. Scope the doc to the changed area — do not document the whole codebase.

Keep the diff minimal and reviewable: one doc per functional change, no unrelated rewrites.

### 4. Verify — reviewable and true

Confirm before reporting done:

- `git diff --stat` shows only `docs/truth/**` and `ROUTES.md`.
- Every claim in the updated doc has a `file:line` pointer that exists in the working tree.
- The doc matches the code + tests, not the other way around.

Report: "Updated <doc> for <change>. Review the truth diff alongside the code diff."

## Document templates

### Behavior (`behaviors/`)

```markdown
# <Behavior Name>

**Area**: <route / component>
**Evidence**: `src/<file>:<line>`

## What it does

<one-paragraph summary, from code + tests>

## Behavior

- <observable behavior> — `src/<file>:<line>`

## Edge cases

- <case> — `src/<file>:<line>`

## Tests

- `tests/<file>.test.ts` — covers <behavior>
```

### Contract (`contracts/`)

```markdown
# <API / Interface>

**Evidence**: `src/<file>:<line>`

## Signature

\`\`\`ts
// the actual exported signature
\`\`\`

## Parameters

| Param | Type | Description |
| ----- | ---- | ----------- |

## Returns / Errors

- ...

## Consumers

- <caller> — `src/<file>:<line>`
```

### Architecture (`architecture/`)

```markdown
# <Component / Module>

**Evidence**: `src/<file>`

## Responsibility

<one paragraph — what it owns, what it doesn't>

## Dependencies

- depends on: <...>
- depended on by: <...>

## Boundaries

- <seam / interface> — `src/<file>:<line>`
```

### Workflow (`workflows/`)

```markdown
# <Workflow Name>

**Evidence**: `src/<file>:<line>`

## Steps

1. <step> — `src/<file>:<line>`

## Trigger / Exit

- trigger: <...>
- success: <...> / failure: <...>
```

### Operations (`operations/`)

```markdown
# <Runbook / Config>

**Evidence**: `src/<file>`

## Config / Env

| Key | Default | Meaning |
| --- | ------- | ------- |

## Runbook

- <action> — <command or step>

## Failure modes

- <symptom> → <cause> → <fix>
```

## Routing file (`ROUTES.md`)

```markdown
# Truth Routes

| Code pattern      | Doc                                      |
| ----------------- | ---------------------------------------- |
| src/auth/session* | engineering/behaviors/session-timeout.md |
| src/api/*         | engineering/contracts/api.md             |
```

Patterns are globs relative to the repo root. One doc may be routed by several patterns; one pattern maps to one doc. Keep patterns as specific as needed to avoid one giant doc.
