---
name: memory
description: Read and write persistent memory files for context retention across sessions — one fact per file with frontmatter
version: 2.0.0
---

# Memory Skill

Manage persistent memory stored as markdown files with YAML frontmatter.

## File Format

Each memory is one `.md` file under the `memory/` directory:

```markdown
---
name: <kebab-case-slug>
description: <one-line summary>
metadata:
  type: user | feedback | project | reference
---

<the fact body>

**Why:** <rationale>
**How to apply:** <practical guidance>
```

## File Path Conventions

- Directory: `~/.mipham/memory/` (user-level) or `./.mipham/memory/` (project-level)
- Filename: `<name-slug>.md` (lowercase, hyphens)
- Index: `MEMORY.md` — one line per memory file, maintained automatically

## Operations

### List Memories

Scan `MEMORY.md` index for available memories. The index has one line per memory:

```markdown
- [Title](file.md) — brief hook
```

### Read Memory

Read the full markdown file including frontmatter. Parse YAML frontmatter for metadata.

### Write Memory

1. Check for existing file with same `name:` slug — update if found
2. Create new file if no match
3. Add/update entry in `MEMORY.md` index
4. Never write what the repo already records (code structure, git history, CLAUDE.md)

### Delete Memory

Remove the file and its index entry. Use when a memory is incorrect or superseded.

## Best Practices

- **One fact per file** — atomic, focused, easy to find
- **Descriptive slugs** — `npm-publish-workflow` not `memory-1`
- **Link related memories** — use `[[slug-name]]` wikilinks in body
- **Check before writing** — search existing memories to avoid duplicates
- **Types matter**: `user` (who), `feedback` (corrections), `project` (goals), `reference` (external)

## Example

```markdown
---
name: api-rate-limit
description: OpenAI API has 500 RPM limit on our tier
metadata:
  type: reference
---

The OpenAI API key for production has a hard 500 requests/minute limit.
Exceeding it returns HTTP 429 with a Retry-After header.

**Why:** We hit this in production during peak usage
**How to apply:** Use exponential backoff; batch requests where possible
```
