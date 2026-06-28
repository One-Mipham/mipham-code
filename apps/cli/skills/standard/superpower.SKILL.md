---
name: superpower
description: Skill discovery and invocation system — find and use skills before any response or action
version: 2.0.0
---

# Superpowers — Using Skills

## The Rule

**Invoke relevant or requested skills BEFORE any response or action.** Even a 1% chance a skill might apply means you should invoke it to check.

## How to Access Skills

Use the `Skill` tool to invoke skills by name. When you invoke a skill, its content is loaded — follow it directly.

## Skill Discovery

### Check Available Skills

Skills are listed in `<system-reminder>` messages. Scan this list when receiving a task.

### Matching Algorithm

1. Parse the user's request for intent keywords
2. Scan skill names and descriptions for matches
3. If ANY skill matches at ≥1% probability → invoke it
4. Multiple matches → invoke all that may apply
5. Invoked skill doesn't fit → that's fine, don't use it

### Priority Order

1. **Process skills first** — brainstorming, systematic-debugging, tdd. These determine HOW to approach
2. **Implementation skills second** — frontend-design, mcp-builder. These guide execution

## Red Flags

These thoughts mean STOP — you're rationalizing:

| Thought | Reality |
|---------|---------|
| "This is just a simple question" | Questions are tasks. Check skills. |
| "I need more context first" | Skill check comes BEFORE clarifying questions. |
| "Let me explore the codebase first" | Skills tell you HOW to explore. |
| "I remember this skill" | Skills evolve. Read current version. |
| "The skill is overkill" | Simple things become complex. Use it. |

## Skill Types

- **Rigid** (TDD, systematic-debugging): Follow exactly. Don't adapt away discipline.
- **Flexible** (patterns): Adapt principles to context.

The skill itself tells you which type it is.

## User Instructions

Instructions say WHAT, not HOW. "Add X" or "Fix Y" doesn't mean skip workflows.
