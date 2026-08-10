---
name: implement
description: Build work from a spec or tickets with systematic discipline — TDD at pre-agreed seams, incremental verification, code review before commit. Use when implementing features, bugfixes, or any planned work.
version: 1.0.0
user-invocable: true
---

# Implement — Structured Build Execution

融合 Superpowers executing-plans（计划审阅 + 隔离工作区）+ Matt Pocock implement（TDD 接缝 + 增量验证 + 提交前审查）。

## When to Use

- Implementing work from a written spec or ticket set
- Executing a development plan with clear deliverables
- Building a feature with predefined success criteria

## When NOT to Use

- Exploratory coding / prototyping → use `prototype` skill
- Quick one-line fixes → just fix it
- No spec or tickets exist → use `to-tickets` or `to-spec` first

---

## Step 1: Load and Review

### 1.1 Ensure isolated workspace

Use git worktree or a feature branch. Never implement on main/master without explicit consent.

### 1.2 Read the plan/spec/tickets

Read the full spec or ticket set. Understand:

- What is being built?
- What are the acceptance criteria?
- What are the pre-agreed seams (where TDD should be applied)?

### 1.3 Review critically

Before writing any code:

- Are there gaps or ambiguities in the spec?
- Are the success criteria testable?
- Do you understand every instruction?

**If concerns exist, raise them before starting.** Don't guess.

---

## Step 2: Execute Tasks

For each task in order:

### 2.1 At pre-agreed seams: TDD

Where the spec specifies (or where interfaces are well-defined):

1. Write a **failing test** that asserts the expected behavior
2. Watch it fail (red)
3. Write the **minimum code** to make it pass (green)
4. Refactor if needed, keeping tests green

Use the `tdd` skill for full red-green-refactor discipline.

### 2.2 Incremental verification

During implementation:

- **Run typecheck** after each significant change: `pnpm typecheck`
- **Run relevant test file** after each task: `pnpm test -- <file>`
- **Don't wait** until everything is done to discover type errors

### 2.3 One task at a time

- Follow each step exactly — the plan has bite-sized steps for a reason
- One change at a time. No "while I'm here" improvements.
- Mark tasks as complete after verification passes

---

## Step 3: Final Verification

After all tasks are complete:

### 3.1 Full test suite

```bash
pnpm test
```

All tests must pass. If any fail, fix before proceeding.

### 3.2 Lint and format

```bash
pnpm lint
pnpm format
```

CI must be green.

---

## Step 4: Code Review

**Before committing**, run code review:

Use the `code-review` skill for a two-axis review:

- **Standards**: Does the diff follow the repo's coding standards?
- **Spec**: Does it faithfully implement the originating issue/spec?

Fix any findings before committing.

---

## Step 5: Commit

Commit your work to the current branch.

```bash
git add -A
git commit -m "<type>: <description>"
```

- Follow Conventional Commits
- Reference the spec/ticket in the commit message
- **Do NOT commit unless explicitly asked** (per CLAUDE.md §关键约束)

---

## When to Stop and Ask

**STOP immediately when:**

- A task is blocked (missing dependency, unclear instruction, verification fails repeatedly)
- The spec has a critical gap that prevents starting
- You don't understand an instruction
- 3+ fix attempts fail — this may be an architectural issue

**Ask for clarification rather than guessing.**

---

## Quick Reference

| Step           | Key Activities                                               | Done When                        |
| -------------- | ------------------------------------------------------------ | -------------------------------- |
| **1. Review**  | Load spec, isolate workspace, review critically              | All concerns raised and resolved |
| **2. Execute** | TDD at seams, incremental typecheck/test, one task at a time | All tasks complete and verified  |
| **3. Verify**  | Full test suite, lint, format                                | CI-ready (all green)             |
| **4. Review**  | Two-axis code review (standards + spec)                      | Findings addressed               |
| **5. Commit**  | Conventional Commits, reference spec/ticket                  | Work committed to branch         |
