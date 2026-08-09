---
name: web-search
description: Search the web for current information — documentation, news, technical references, troubleshooting, and research. Routes queries through Brave Search API with domain filtering and source verification.
version: 3.0.0
user-invocable: true
allowed-tools:
  - WebSearch
  - WebFetch
---

# Web Search — Executable Workflow

**Type**: Flexible — follow the query construction rules strictly, then adapt verification depth to the task.

**Purpose**: Find accurate, current information from the web. This skill covers query formulation, domain filtering, result verification, and when to follow up with WebFetch for deep reading.

**Triggers**: "search for", "look up", "find", "what is", "how to", "latest", "current", "news about", "documentation for", "research"

---

## Phase 0: Decide Whether to Search (ALWAYS RUN FIRST)

```
Question involves...
├── Current events, news, recent releases?
│   └── YES → Search (model training cutoff limitation)
│
├── Library/framework documentation?
│   └── YES → Search (version-specific, up-to-date)
│
├── Error messages, stack traces?
│   └── YES → Search (known issues, fixes)
│
├── Technology comparisons, benchmarks?
│   └── YES → Search (current data)
│
├── Pure logic, algorithms, math?
│   └── NO → Reason directly (no external data needed)
│
├── Question answerable from code in context?
│   └── NO → Use existing context (faster, no network)
│
└── Opinion / subjective?
    └── MAYBE → Search for data points, not consensus
```

---

## Phase 1: Construct the Query

### Rules (apply in order)

1. **Be specific**: include version numbers, dates, proper nouns
2. **Use technical terms**: framework/language jargon over natural language
3. **Include context**: OS, environment, constraints if relevant
4. **English preferred**: technical content is richer in English

### Examples

```
❌ "React"                                → too broad
❌ "React problems"                       → ambiguous
❌ "how to make website fast"             → natural language
✅ "React 19 useEffect double mount fix"  → specific + versioned
✅ "Core Web Vitals LCP optimization Next.js 14"
✅ "Prisma 5 findMany nested include filter TypeScript"
✅ "playwright click button not working 2026"
```

### For Chinese-Language Queries

Chinese queries work but yield fewer technical results:

```
✅ "React 19 useEffect 执行两次 修复"     → mixed language for best results
✅ "Vue 3 Composition API 最佳实践 2026"
```

---

## Phase 2: Filter & Verify Results

### Domain Authority Tiers

| Tier              | Domains                                                               | Weight  |
| ----------------- | --------------------------------------------------------------------- | ------- |
| **Official**      | docs.github.com, nextjs.org, nodejs.org, python.org, rust-lang.org    | Highest |
| **Authoritative** | developer.mozilla.org, web.dev, kubernetes.io                         | High    |
| **Trusted**       | stackoverflow.com (high-score), dev.to, medium.com (verified authors) | Medium  |
| **Low**           | personal blogs, random forums, w3schools                              | Low     |

### Use allowed_domains for targeted searches

```json
{ "query": "Next.js caching", "allowed_domains": ["nextjs.org", "github.com"] }
```

### Use blocked_domains to exclude noise

```json
{ "query": "JavaScript array methods", "blocked_domains": ["w3schools.com"] }
```

### Cross-Reference Rule

- **Critical claims** (API behavior, security): 2+ independent sources
- **Code examples**: test before recommending
- **Version info**: check publish date (prefer current year)

---

## Phase 3: Deep Read (When Needed)

After search returns results, decide whether to deep-read:

```
Search result looks promising?
├── Snippet answers the question fully?
│   └── → Use snippet + cite source (done)
│
├── Need code examples / detailed API docs?
│   └── → WebFetch the page URL
│       Use prompt to focus extraction
│
├── Multiple sources needed for verification?
│   └── → WebFetch top 2-3 results
│       Cross-reference and flag contradictions
│
└── Page is JavaScript SPA / login-walled?
    └── → Delegate to web-access skill (ComputerUse browser)
```

---

## Phase 4: Report Results

### Format

```markdown
## [Topic]

[Answer with inline citations]

### Details (if deep-read was done)

[Structured content from fetched pages]

Sources:

- [Title](URL) — [1-sentence note on what was found there]
- [Title](URL) — [1-sentence note]
```

### Attribution Rules

- Always include source URLs
- Note if a source is official docs vs community
- Flag outdated content (e.g., "article from 2024, may be stale")
- Distinguish between facts (need citation) and reasoning (your own)

---

## Search API Configuration

Web search uses **Brave Search API** (free tier: 2,000 queries/month).

If search returns "not configured":

1. Get a free API key at https://brave.com/search/api/
2. Set: `export BRAVE_API_KEY="BSA..."`
3. Restart Mipham Code

Alternatives (additional API keys supported):

- `TAVILY_API_KEY` — https://tavily.com
- `SERPAPI_API_KEY` — https://serpapi.com
