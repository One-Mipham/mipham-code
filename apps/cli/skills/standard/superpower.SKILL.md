---
name: superpower
description: Skill discovery and invocation system — find and use skills before any response or action
version: 2.1.0
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, ignore this skill.
</SUBAGENT-STOP>

# Superpowers — Using Skills

## The Rule

**Invoke relevant or requested skills BEFORE any response or action.** Even a 1% chance a skill might apply means you should invoke it to check.

Then announce "Using [skill] to [purpose]" and follow the skill exactly. If it has a checklist, create a todo per item.

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

1. **Process skills first** — to-spec, debug-loop, tdd. These determine HOW to approach
2. **Implementation skills second** — implement, codebase-design. These guide execution

## Red Flags

These thoughts mean STOP — you're rationalizing:

| Thought                             | Reality                                                |
| ----------------------------------- | ------------------------------------------------------ |
| "This is just a simple question"    | Questions are tasks. Check skills.                     |
| "I need more context first"         | Skill check comes BEFORE clarifying questions.         |
| "Let me explore the codebase first" | Skills tell you HOW to explore. Check first.           |
| "I can check git/files quickly"     | Files lack conversation context. Check for skills.     |
| "Let me gather information first"   | Skills tell you HOW to gather information.             |
| "This doesn't need a formal skill"  | If a skill exists, use it.                             |
| "I remember this skill"             | Skills evolve. Read current version.                   |
| "This doesn't count as a task"      | Action = task. Check for skills.                       |
| "The skill is overkill"             | Simple things become complex. Use it.                  |
| "I'll just do this one thing first" | Check BEFORE doing anything.                           |
| "This feels productive"             | Undisciplined action wastes time. Skills prevent this. |
| "I know what that means"            | Knowing the concept ≠ using the skill. Invoke it.      |

## Skill Types

- **Rigid** (tdd, debug-loop): Follow exactly. Don't adapt away discipline.
- **Flexible** (patterns): Adapt principles to context.

The skill itself tells you which type it is.

## User Instructions

User instructions (CLAUDE.md, AGENTS.md, MIPHAM.md, direct requests) take precedence over skills, which in turn override default behavior.

Instructions say WHAT, not HOW. "Add X" or "Fix Y" doesn't mean skip workflows. Only skip a skill workflow when the user has explicitly told you to.
