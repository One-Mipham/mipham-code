---
name: grill-with-docs
description: A relentless interview to sharpen a plan or design, creating CONTEXT.md (shared language) and ADRs (architectural decisions) as we go. Use before any non-trivial implementation to align on requirements and terminology.
version: 1.0.0
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - WebSearch
  - WebFetch
---

# Grill With Docs — Deep Requirements Alignment

Inspired by Matt Pocock's `grill-with-docs` and `domain-modeling` skills. Before writing code, run a structured interview to align on requirements, establish shared language, and record architectural decisions.

## When to Use

- Before any non-trivial feature implementation
- When requirements are fuzzy ("make it faster", "add X")
- When you need to establish project terminology
- When architectural decisions need to be recorded
- User says: "plan X", "design Y", "what should we do about Z"

## When NOT to Use

- Trivial bug fixes with clear expected behavior
- One-line changes
- Tasks where the requirements are already crystal clear

---

## The Interview Flow

### Phase 1: Understand the Intent

Start by understanding what the user actually wants. Don't ask "what should I build?" — ask about their goal.

**Core Questions:**
1. What problem are you solving? (Not what feature you're building)
2. Who is this for? (End user, developer, internal tool?)
3. What does success look like? (How will you know when it's done?)
4. What's the deadline or priority context?

**Anti-pattern**: Jumping to implementation questions ("Do you want REST or GraphQL?") before understanding the problem.

### Phase 2: Sharpen the Language

Identify vague or overloaded terms and pin them down **immediately**. This is the single highest-leverage activity — shared language reduces token waste and prevents misunderstandings.

**Technique: The Canonical Term**
- When the user uses multiple words for the same thing, pick one as canonical
- List rejected alternatives under `_Avoid_`
- Be opinionated — the glossary is prescriptive, not descriptive

```
User: "We need a way for users to save articles for later."
You: "Let's pin that down. 'Save for later' could mean bookmarking, or a reading list, or offline download. Which one?"
User: "Like a reading list — they can come back to it."
You: "Got it. Let's call it a **Reading List**. Avoid 'bookmark', 'save', 'favorites'."
→ Write to CONTEXT.md immediately.
```

**Technique: The Boundary Test**
- When a term is proposed, test its boundaries with edge cases
- "Does X include Y? What about Z?"

**Technique: The Code Cross-Reference**
- When the user describes how something works, check if existing code agrees
- Surface contradictions immediately

### Phase 3: Probe Edge Cases

Before accepting any requirement, stress-test it with edge cases.

**Edge Case Inventory:**
- **Empty state**: What does the user see when there's nothing yet?
- **Error state**: What happens when things go wrong?
- **Extreme values**: What about 0? What about 10,000?
- **Concurrency**: What if two people do this at the same time?
- **Permissions**: Who can do this? Who cannot?
- **Scale**: What changes at 10x the current volume?

**Technique: The 5 Whys**
When a requirement seems odd, dig deeper:
```
User: "We need real-time updates."
You: "Why real-time?"
User: "Because users need to see changes immediately."
You: "Why do they need to see changes immediately?"
User: "Because they're collaborating on the same document."
→ Now you know the REAL requirement is collaboration, not real-time.
```

### Phase 4: Make Architecture Decisions

When a design decision meets ALL three criteria, offer to record it as an ADR:
1. **Hard to reverse** — changing your mind later has real cost
2. **Surprising without context** — a future reader would wonder "why?"
3. **The result of a real trade-off** — there were genuine alternatives

**What qualifies for an ADR:**
- Architecture shape (monorepo vs polyrepo, event sourcing vs CRUD)
- Integration patterns between contexts
- Technology choices with lock-in (database, message bus, auth provider)
- Deliberate deviations from convention ("we use raw SQL because...")
- Constraints not visible in code ("we can't use X because compliance")

**ADR Format** (write to `docs/adr/NNNN-slug.md`):
```markdown
# {Short title of the decision}

{1-3 sentences: context, decision, and why.}
```

Only add optional sections (Status, Considered Options, Consequences) when they add genuine value. Most ADRs are a single paragraph.

### Phase 5: Write the CONTEXT.md

After the interview, synthesize everything into `CONTEXT.md`.

**Format** (`CONTEXT.md` at project root):
```markdown
# {Project Name} Context

{One or two sentence description of the project domain.}

## Language

**{Term}**:
{One or two sentence definition of what it IS.}
_Avoid_: {alternative terms that should not be used}

## Decisions

- [ADR 0001: {Title}](docs/adr/0001-slug.md) — {one-line summary}
```

**Rules:**
- Be opinionated — pick the best term, ban the rest
- Only include domain-specific terms (not general programming concepts)
- Keep definitions tight — one or two sentences
- Update inline during the conversation, don't batch
- CONTEXT.md is a glossary, NOT a spec or implementation plan

---

## During the Conversation

### DO

- Challenge the user when they use vague terms — "What do you mean by 'fast'?"
- Propose canonical terms and write them down immediately
- Invent edge cases and probe boundaries
- Offer ADRs sparingly (only when all 3 criteria are met)
- Cross-reference with existing code if available
- Call out contradictions between what the user says and what the code does

### DON'T

- Rush to implementation questions before understanding the problem
- Write ADRs for trivial decisions
- Let fuzzy language slide — pin it down now or pay later
- Treat CONTEXT.md as a spec or scratch pad
- Ask yes/no questions when open-ended ones would reveal more

---

## Output

After the interview, the user should have:

1. **CONTEXT.md** — shared language glossary (created or updated)
2. **ADRs** (if needed) — architectural decisions in `docs/adr/`
3. **Clear requirements** — edge cases explored, assumptions surfaced
4. **Shared understanding** — you and the user now mean the same thing by the same words

---

## Integration with Mipham Code

- **Memory System**: Key terms go to project memory for persistence across sessions
- **Critical Thinking Layer**: Apply the 5-dimension self-check (evidence standard, equivalence verification, counter-example search, confidence calibration, depth check) to your own interview questions
- **Workflow**: For complex projects, the output of this skill feeds directly into `/implement`
