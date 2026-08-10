---
name: research
description: Deep research against primary sources, executed as a background agent. Collects findings into a single cited Markdown file. Use for investigation that requires reading official docs, source code, specs, or first-party APIs — not secondary summaries.
version: 1.0.0
user-invocable: true
allowed-tools:
  - WebSearch
  - WebFetch
  - Agent
  - Bash
  - Write
  - Read
---

# Research — Background Deep Research

融合 Mipham web-search v3.0（查询构建+验证）+ Matt Pocock research（后台代理+一手来源+Markdown 报告）。

## When to Use

- "Research X for me"
- "Find out everything about Y from primary sources"
- "Investigate Z and write up findings"
- Any question where googling + reading multiple sources is the right answer

## When NOT to Use

- Quick fact lookup → use `/web-search` directly
- Question answerable from code already in context
- Pure logic/algorithmic question

---

## Phase 0: Route

```
Research task is...
├── Quick (1-2 sources, immediate answer)?
│   └── → Use web-search skill directly (Phase 0-4)
│
├── Deep (multiple sources, needs synthesis)?
│   └── → THIS SKILL — background agent
│
└── Login-walled / SPA-only sources?
    └── → web-access skill (ComputerUse browser)
```

---

## Phase 1: Spin Up Background Agent

Launch a **background agent** to do the heavy reading, so you keep working while it researches.

The agent's instructions:

```
You are a research agent. Your task:

1. Investigate the question against PRIMARY SOURCES ONLY:
   - Official documentation (docs.*.com, *.org)
   - Source code repositories (GitHub, GitLab)
   - Technical specifications (RFCs, standards)
   - First-party API references
   - NOT: blog posts, Medium articles, forum threads, secondary summaries

2. For every claim, follow it back to the source that owns it.
   If a secondary source makes a claim, find the primary source and cite that.

3. Use WebSearch to find sources.
   Use WebFetch to deep-read promising pages.
   Cross-reference critical claims across 2+ independent primary sources.

4. Write findings to a SINGLE Markdown file.
   - Cite every claim with its primary source URL
   - Distinguish between facts (needs citation) and reasoning (your own)
   - Flag outdated content ("article from 2024, may be stale")
   - Note if a source is official docs vs community

5. Save the file where the repo already keeps such notes.
   Match existing conventions. If none exist, put it in docs/research/.
```

---

## Phase 2: Report Format

The agent writes findings in this structure:

```markdown
# [Research Topic]

**Date**: YYYY-MM-DD
**Sources**: N primary, M cross-references

## Key Findings

- [Finding 1] — [Source](URL)
- [Finding 2] — [Source](URL)

## Detailed Analysis

### [Subtopic A]

[Claim and citation]

### [Subtopic B]

[Claim and citation]

## Source Evaluation

| Source | Type | Authority | Notes |
|--------|------|-----------|-------|
| [Name](URL) | Official docs | High | Current as of YYYY-MM |
| [Name](URL) | Source code | High | Tag vX.Y.Z |

## Open Questions

- [Question 1]
- [Question 2]

Sources:
- [Title](URL) — brief note
```

---

## Phase 3: Review

When the background agent completes:

1. Read the output file
2. Spot-check: did it follow the chain back to primary sources?
3. Flag any claims that need further verification
4. Surface uncertainties to the user

---

## Research Quality Checklist

- [ ] Every factual claim has a primary source citation
- [ ] At least one critical claim is cross-referenced (2+ sources)
- [ ] Source type is clearly identified (official docs / source code / spec / community)
- [ ] Outdated content is flagged with publication year
- [ ] Reasoning vs facts are clearly distinguished
- [ ] File saved in repo-appropriate location
