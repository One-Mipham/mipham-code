---
name: to-spec
description: Turn a conversation into a structured specification document. Use after a grill-with-docs session or any requirements discussion to capture decisions in a durable, shareable format.
version: 1.0.0
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
---

# To Spec — Conversation → Specification

Turn the output of a requirements discussion into a structured specification document. This is the bridge between `/grill-with-docs` (alignment) and `/triage` (task decomposition).

## When to Use

- After a `/grill-with-docs` session — capture what was decided
- After any requirements discussion — before starting implementation
- User asks: "write this up", "create a spec", "document the plan"
- Before handing off work to another session or person

## When NOT to Use

- The requirements are a single sentence and obvious
- You're in the middle of a grill session — finish the interview first
- The scope is so small that the spec would be longer than the implementation

---

## Spec Format

Write to `docs/specs/YYYY-MM-DD-slug.md`:

```markdown
---
status: draft | approved | implemented
created: 2026-08-10
---

# {Title}

## Problem

{What problem are we solving? Why now? 1-3 sentences.}

## Scope

### In Scope
- {What we're building}

### Out of Scope (Explicit)
- {What we're NOT building — prevents scope creep}

## Requirements

### Functional
- **{Requirement}**: {Description}. Acceptance: {measurable criterion}.

### Non-Functional
- **Performance**: {latency, throughput targets}
- **Security**: {auth, data protection, threat model}
- **Scale**: {expected volume, growth projections}

## Design Decisions

- **Decision**: {What we decided}. Because: {why}. Alternatives considered: {options + reasons rejected}.

## Domain Model

{Key terms and their definitions — from CONTEXT.md or the grill session.}

## Edge Cases

- **{Scenario}**: {Expected behavior}
- **{Scenario}**: {Expected behavior}

## Open Questions

- {Question} — {who needs to answer / when needed}
```

---

## The Spec Workflow

### Step 1: Extract from Conversation

Scan the conversation history for:
- Decisions made (explicit and implicit)
- Terms defined (candidates for CONTEXT.md)
- Edge cases discussed
- Alternatives rejected (and why)
- Open questions that remain

### Step 2: Fill Gaps

For each gap you find:
- Edge cases not discussed → flag as Open Questions
- Terms used but not defined → propose definitions
- Assumptions not stated → make them explicit

### Step 3: Validate with User

Present the spec and ask:
1. "Does this match your understanding?"
2. "What's missing?"
3. "What's wrong?"
4. "What surprised you?"

### Step 4: Feed Into Triage

Once approved, the spec's functional requirements become tickets in `/triage`. Non-functional requirements become acceptance criteria.

---

## Anti-Patterns

- **Waterfall trap**: Don't try to spec everything upfront. Spec the next increment. Specs are living documents, not contracts.
- **Premature detail**: Don't spec API signatures or DB schemas in the spec — those are implementation details.
- **Vague acceptance**: "Works well" is not acceptance criteria. "Returns 200 with valid JWT within 500ms" is.

---

## Integration With Mipham Code

- **grill-with-docs**: Input — the grill session produces the raw material
- **triage**: Output — the spec feeds into ticket decomposition
- **domain-modeling**: Terms discovered during spec writing go to CONTEXT.md
- **Memory System**: The spec file persists as project reference across sessions
