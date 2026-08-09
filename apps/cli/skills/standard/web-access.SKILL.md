---
name: web-access
description: All network operations — web search, page fetching, authenticated browsing, social media scraping, dynamic page rendering. Routes to the correct tool (WebSearch/WebFetch/ComputerUse browser) based on the task.
version: 2.0.0
user-invocable: true
allowed-tools:
  - Bash
  - WebFetch
  - WebSearch
  - ComputerUse
  - Read
---

# Web Access — Executable Workflow

**Type**: Flexible — use the decision tree to route to the right tool, then adapt to the specific site.

**Purpose**: All network-bound operations go through this skill. It routes the request to the correct underlying tool and handles authentication, rendering, and extraction strategy.

**Triggers**: "search for", "look up", "find information about", "fetch this URL", "scrape", "browser", "login to", "check this website", "web", "online"

---

## Phase 0: Route to the Right Tool (ALWAYS RUN FIRST)

```
User request involves network?
├── Search engine query (find/discover/look up)?
│   └── → WebSearch tool
│       Query best practices: specific + versioned + technical terms
│
├── Read a known URL (docs/article/API)?
│   └── → WebFetch tool
│       HTTP auto-upgrades to HTTPS, HTML converts to markdown
│       Cached for 15 minutes — re-fetch only if stale
│
├── Login-required site? JavaScript SPA? Form submission?
│   └── → ComputerUse browser automation
│       browser_navigate → browser_snapshot → browser_click
│
├── Social media (Xiaohongshu, Weibo, Twitter, etc.)?
│   └── → ComputerUse browser (render JS, handle auth)
│       OR → WebFetch if public page
│
└── API endpoint (REST/GraphQL)?
    └── → WebFetch with prompt for structured extraction
```

---

## Phase 1: Web Search

Use `WebSearch` for discovery queries — finding documentation, news, troubleshooting, comparisons.

### Query Construction

```
❌ "React"                           → too broad
❌ "React problems"                  → ambiguous
✅ "React 19 useEffect double mount fix 2026"  → specific + versioned
✅ "Next.js 14 App Router caching behavior"     → targeted
```

### Domain Filtering

Use `allowed_domains` for authoritative sources:
- `docs.github.com` — GitHub docs
- `nextjs.org` — Next.js official
- `developer.mozilla.org` — MDN
- `nodejs.org` — Node.js official

Use `blocked_domains` to exclude noise (e.g., exclude `w3schools.com` when looking for MDN).

### Verification

- Cross-reference claims across 2+ independent sources
- Prefer results from current year
- Authority: official docs > well-known blogs > Stack Overflow > random forums

### Source Attribution

Always end responses with:
```markdown
Sources:
- [Title](URL) — brief note
```

---

## Phase 2: Web Fetch

Use `WebFetch` for reading a specific URL.

### What it does

- Auto-upgrades HTTP → HTTPS
- Converts HTML to Markdown (headings, links, images, lists, code blocks)
- Strips scripts, styles, nav, header, footer before conversion
- Caches results for 15 minutes per URL
- Detects cross-host redirects and reports them
- Truncates content at 100K characters

### Prompt Parameter

Use `prompt` to guide extraction focus:
```
WebFetch: url="https://docs.example.com", prompt="find the authentication API section"
```

### When NOT to use WebFetch

- Search queries → use WebSearch
- Login-required pages → use ComputerUse browser
- Large file downloads → use Bash + curl/wget
- API endpoints returning JSON → WebFetch works, returns raw JSON

---

## Phase 3: Browser Automation (ComputerUse)

Use `ComputerUse` for interactive browsing — login, form submission, JavaScript rendering.

### Available Actions

| Action | Purpose |
|--------|---------|
| `browser_navigate` | Go to a URL |
| `browser_snapshot` | Capture accessibility tree (page structure) |
| `browser_click` | Click an element by UID |
| `screenshot` | Capture visible viewport |
| `launch` | Open a desktop application |

### Workflow for Authenticated Sites

```
1. browser_navigate → login page
2. browser_snapshot → find form fields (UIDs)
3. Ask user for credentials (NEVER auto-fill)
4. browser_click → submit
5. browser_navigate → target page
6. browser_snapshot → extract content
```

### Workflow for SPAs (React/Vue/Angular)

```
1. browser_navigate → SPA URL
2. Wait 2-3 seconds (JavaScript render)
3. browser_snapshot → extract rendered content
```

### Prerequisites

- Playwright must be installed: `npm install playwright`
- First launch opens a visible browser window (headless: false)

---

## Phase 4: Extraction & Synthesis

After fetching content (via any method):

### Content Extraction
1. Identify relevant sections using the prompt/h3 headings
2. Extract key facts, code examples, API signatures
3. Note the source URL for attribution

### Cross-Referencing
1. Verify technical claims across 2+ sources
2. Flag contradictions between sources
3. Note version/deprecation warnings

### Output Format
```markdown
## [Topic]

[Key finding with source attribution]

### Details
[Structured content from page]

Sources:
- [Title](URL)
```

---

## Security Rules

- **Never submit credentials** without explicit user approval
- Respect `robots.txt` and rate limiting
- Do not scrape PII or sensitive data
- All URLs validated against SSRF before fetching
- Only HTTPS for remote requests (HTTP auto-upgraded)
- Cross-host redirects reported to caller (not silently followed)

---

## When NOT to Use This Skill

- Pure logic / algorithmic questions (reasoning, not research)
- Questions answerable from code already in context
- Opinions / subjective recommendations (search for data, not consensus)
- Downloading large binaries → use Bash + curl
