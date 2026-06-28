---
name: web-search
description: Search the web for current information — documentation, news, technical references, and troubleshooting
version: 2.0.0
---

# Web Search

Use `WebSearch` tool to find current, accurate information from the web.

## When to Use

- **Library/framework docs**: API references, migration guides, version-specific features
- **Current events**: News, releases, incidents (anything after training cutoff)
- **Troubleshooting**: Error messages, stack traces, known issues
- **Comparisons**: Technology trade-offs, benchmark data
- **Code examples**: Real-world usage patterns, configuration snippets

## Query Best Practices

### Be Specific

```
❌ "React"                              → too broad
❌ "React problems"                     → ambiguous
✅ "React 19 useEffect double mount fix" → specific, versioned
✅ "Next.js 14 App Router caching behavior 2026" → targeted
```

### Use Technical Terms

```
❌ "how to make website fast"
✅ "Core Web Vitals LCP optimization Next.js 14"
```

### Include Version Numbers

```
❌ "prisma query"
✅ "Prisma 5.0 findMany with nested include filter"
```

### Domain Filtering

Use `allowed_domains` for authoritative sources:
- `docs.github.com` — GitHub documentation
- `nextjs.org` — Next.js official docs
- `developer.mozilla.org` — MDN Web Docs
- `nodejs.org` — Node.js official

## Verification

- **Cross-reference**: Verify claims across 2+ independent sources
- **Recency**: Prefer results from the current year; note article dates
- **Authority**: Official docs > well-known blogs > Stack Overflow > random forums
- **Cite sources**: Always include source URLs in responses

## Source Attribution

After answering from search results, end with:
```markdown
Sources:
- [Title](URL) — brief note
- [Title](URL) — brief note
```

## When NOT to Search

- Pure logic or algorithmic questions (reasoning, not research)
- Questions answerable from code already in context
- Opinions and subjective recommendations (search for data, not consensus)
