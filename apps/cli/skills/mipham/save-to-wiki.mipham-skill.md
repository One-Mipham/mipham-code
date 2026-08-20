---
name: save-to-wiki
description: Save the current conversation, an insight, or a decision into the Obsidian wiki vault (~/MiphamAI) as a structured note. Analyzes the chat, picks a note type (synthesis/concept/source/decision/session), writes it via the Obsidian MCP, and leaves a memory pointer back. Use when the user types /save, says "save this to the wiki", "file this", "keep this insight", or wants a decision/concept archived.
version: 1.0.0
---

# Save to Wiki

Good answers and insights shouldn't disappear into chat history. This skill files the most valuable content from the current conversation into the user's Obsidian wiki as a permanent, searchable note.

The wiki compounds. Save often.

## Transport

Writes go through the Obsidian MCP server (`obsidian` in `~/.mipham/mcp.json`), exposed as tools prefixed `mcp__obsidian__`:

- `mcp__obsidian__create_note` — create a new note (target path + markdown body)
- `mcp__obsidian__append_note` — append to an existing note
- `mcp__obsidian__get_file` / `mcp__obsidian__list_files` — check whether a note already exists
- `mcp__obsidian__set_property` — update frontmatter properties

If a tool name is unfamiliar, run `/mcp` to list the connected Obsidian tools and use the exact names. Avoid `get_vault_info` — it has a known upstream bug (`Command "vault" not found`) and is not needed for writing.

## Note Type Decision

Pick the best type from the conversation content. If the user specifies a type, use it.

| Type      | Folder (`wiki/`) | Use when                                                 |
| --------- | ---------------- | -------------------------------------------------------- |
| synthesis | `questions/`     | Multi-step analysis, comparison, or answer to a question |
| concept   | `concepts/`      | Explaining or defining an idea, pattern, or framework    |
| source    | `sources/`       | Summary of external material discussed in the session    |
| decision  | `meta/`          | Architectural, project, or strategic decision made       |
| session   | `sessions/`      | Full session summary — captures everything discussed     |

When in doubt, use `synthesis`.

## Frontmatter

All note types share this base frontmatter (aligns with the vault's `_templates/`):

```yaml
---
type: <synthesis|concept|source|decision|session>
title: 'Note Title'
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags:
  - <relevant-tag>
status: developing
related:
  - '[[Any Wiki Page Mentioned]]'
sources: []
saved_from: Mipham Code
mipham_memory: <memory-slug>
---
```

- `synthesis` adds: `question: "<original query>"`, `answer_quality: solid`
- `decision` adds: `decision_date: YYYY-MM-DD`
- `saved_from` and `mipham_memory` implement the light two-way bridge (see below).

## Workflow

1. **Scan** the conversation and identify the single most valuable content to preserve — an insight, a decision with rationale, or a synthesis. If the conversation is trivial (mechanical Q&A, setup steps already documented, temp debugging), say so and skip.
2. **Determine** the note type using the table. Respect an explicit type/title from the user.
3. **Name** the note — short and descriptive; ask the user if not already named.
4. **Check existence** — use `list_files`/`get_file` to see whether `wiki/<folder>/<title>.md` already exists. If it does, offer to update (`append_note` or rewrite) instead of duplicating.
5. **Write** the note via `create_note` (path `wiki/<folder>/<title>.md`) with full frontmatter and a declarative, present-tense body.
6. **Leave a memory pointer** — write a `reference` memory via the Memory tool (`action=write`, `name=wiki-<title-slug>`) whose body records the wiki note path and a one-line summary. This lets `/memory` and recall surface the wiki note.
7. **Update** `wiki/index.md` (add the note to the relevant section) and `wiki/log.md` (prepend `## [YYYY-MM-DD] save | Note Title`). Refresh `wiki/hot.md` if it tracks recent additions.

## Light Two-Way Bridge

- **memory → wiki**: the pointer memory (step 6) stores the wiki path, so memory recall can link back to the note.
- **wiki → memory**: the note's frontmatter carries `saved_from: Mipham Code` and `mipham_memory: <slug>` — plain strings, not wikilinks, so they don't create broken links in Obsidian.

This is a one-way pointer plus a provenance back-reference, not a sync layer. Do not attempt bidirectional synchronization.

## Writing Style

- Declarative, present tense. Write the knowledge, not the conversation.
- Not: "The user asked about X and Claude explained..."
- Yes: "X works by doing Y. The key insight is Z."
- Link mentioned concepts/entities/wiki pages with `[[wikilinks]]`.
- Cite sources where applicable: `(Source: [[Page]])`.

## What to Save vs. Skip

**Save**: non-obvious insights, decisions with rationale, analyses that took real effort, comparisons likely to be referenced again, research findings.

**Skip**: mechanical Q&A, setup steps already documented, temporary debugging with no lasting insight, anything already in the wiki (update instead of duplicating).
