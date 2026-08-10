---
name: domain-modeling
description: Build and sharpen a project's domain model. Use when the user wants to pin down domain terminology or a ubiquitous language, record an architectural decision, or when another skill needs to maintain the domain model.
version: 1.0.0
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# Domain Modeling — Continuous Shared Language

Actively build and sharpen the project's domain model as you work. This is the _active_ discipline — challenging terms, inventing edge-case scenarios, and writing the glossary and decisions down the moment they crystallize. (Merely _reading_ `CONTEXT.md` for vocabulary is not this skill — that's a one-line habit any skill can do. This skill is for when you're changing the model, not just consuming it.)

## File Structure

```
/
├── CONTEXT.md              ← shared language glossary
├── docs/
│   └── adr/
│       ├── 0001-slug.md    ← architectural decisions
│       └── 0002-slug.md
└── src/
```

Create files lazily — only when you have something to write.

**Multiple contexts**: If a `CONTEXT-MAP.md` exists, read it to find which context the current topic relates to.

---

## During the Session

### Challenge Against the Glossary

When the user uses a term that conflicts with existing language in `CONTEXT.md`, call it out immediately:

> "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen Fuzzy Language

When the user uses vague or overloaded terms, propose a precise canonical term:

> "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss Concrete Scenarios

When domain relationships are discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force precision about boundaries between concepts.

### Cross-Reference With Code

When the user states how something works, check whether the code agrees. Surface contradictions:

> "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update CONTEXT.md Inline

When a term is resolved, update `CONTEXT.md` right there. Don't batch — capture as they happen.

### Offer ADRs Sparingly

Only create an ADR when ALL three are true:

1. **Hard to reverse** — changing your mind later has real cost
2. **Surprising without context** — a future reader would wonder "why?"
3. **The result of a real trade-off** — there were genuine alternatives

---

## CONTEXT.md Format

```markdown
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**{Term}**:
{One or two sentence definition of what it IS.}
_Avoid_: {alternative terms that should not be used}
```

### Rules

- **Be opinionated.** Pick the best term, ban the rest.
- **Keep definitions tight.** One or two sentences max.
- **Only domain-specific terms.** Not general programming concepts.
- **Group under subheadings** when natural clusters emerge.

---

## ADR Format

```markdown
# {Short title of the decision}

{1-3 sentences: context, decision, and why.}
```

Number sequentially (`docs/adr/0001-slug.md`, `0002-slug.md`, ...).

Optional sections (only when they add value):

- **Status** frontmatter: `proposed | accepted | deprecated | superseded by ADR-NNNN`
- **Considered Options**: rejected alternatives worth remembering
- **Consequences**: non-obvious downstream effects

### When an ADR Qualifies

- Architecture shape (monorepo, event sourcing, microservices)
- Integration patterns between contexts
- Technology choices with lock-in (database, message bus, auth)
- Boundary and scope decisions ("X owns Y, Z references by ID only")
- Deliberate deviations from convention
- Constraints not visible in code (compliance, latency SLA)
- Rejected alternatives when non-obvious (stops someone suggesting it again in 6 months)

---

## Integration With Mipham Code

- **Memory System**: Domain terms discovered through this skill persist to project memory
- **grill-with-docs**: For initial domain establishment, use `/grill-with-docs`. This skill handles ongoing maintenance
- **Critical Thinking Layer**: Apply counter-example search to domain definitions — "does this definition hold for all edge cases?"
