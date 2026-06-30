---
name: doc-generator
description: Generate technical documentation from code — API docs, README, ADR, changelog, and contributing guides
version: 2.0.0
---

# Documentation Generator

Generate comprehensive, well-structured technical documentation from codebases.

## Document Types

### API Documentation

Extract from TypeScript types and JSDoc:

1. Scan export declarations (interfaces, types, functions, classes)
2. Read JSDoc comments for `@param`, `@returns`, `@throws`, `@example`
3. Group by module or feature area
4. Generate markdown tables for parameter lists
5. Include usage examples from test files when available

Template:

```markdown
## `functionName(params)`

**Description** — extracted from JSDoc

| Param | Type | Description |
| ----- | ---- | ----------- |
| x     | T    | ...         |

**Returns**: `ReturnType` — description

**Example**:
\`\`\`ts
// usage
\`\`\`
```

### README Files

Required sections: title + badge → one-liner → install → quick start → API → contributing → license.

### Architecture Decision Records (ADR)

Format:

```markdown
# ADR-NNN: Title

**Date**: YYYY-MM-DD
**Status**: proposed | accepted | deprecated | superseded

## Context

## Decision

## Consequences
```

### Changelog

Generate from `git log` with Conventional Commits filtering:

```bash
git log --pretty=format:'- %s (%h)' v0.1.0..HEAD
```

Group by type: feat / fix / chore / docs / refactor.

### Contributing Guide

Standard sections: setup → workflow → commit conventions → PR process → code style → testing.

## Output Rules

- All output in clean, well-structured markdown
- Code examples must be syntactically correct
- Cross-reference related documents with relative links
- Use tables for structured data, lists for sequential steps
