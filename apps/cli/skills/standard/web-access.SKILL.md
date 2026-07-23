---
name: web-access
description: Web access, scraping, browser automation, and online content retrieval — search engines, page fetching, login-required sites, social media
version: 1.0.0
---

# Web Access Skill

Handle all network operations: search, web scraping, authenticated browsing, and dynamic page rendering.

## When to Use

- **Web search**: Finding current information, documentation, news
- **Page scraping**: Extracting content from web pages
- **Authenticated access**: Sites requiring login (via browser automation)
- **Social media**: Content from Xiaohongshu, Weibo, Twitter, etc.
- **Dynamic content**: JavaScript-rendered pages requiring a real browser
- **API interaction**: REST/GraphQL endpoints with proper auth

## Tools

### WebSearch
General web search for current information. Use for:
- Documentation lookups, API references
- News and current events
- Technical troubleshooting
- Technology comparisons

### WebFetch
Fetch and parse a single URL. Use for:
- Reading documentation pages
- Checking API responses
- Extracting article content
- Verifying links

### Browser Automation
For sites requiring login or JavaScript rendering:
- Authenticated sessions
- Single-page applications (SPAs)
- Form submissions and multi-step workflows

## Security Rules

- Never submit credentials without explicit user approval
- Respect robots.txt and rate limiting
- Do not scrape PII or sensitive data
- Validate all URLs against SSRF before fetching
- Only HTTPS for remote requests
