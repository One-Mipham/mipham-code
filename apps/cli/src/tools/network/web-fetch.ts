import type { ToolDefinition } from '../../shared/index.ts'
import { PACKAGE_VERSION } from '../../shared/package-info'
import { validateUrl } from '../../security/url'

// ── In-memory cache (15-min TTL per URL) ──

/** Most characters returned in one call. Past this the caller pages with `offset`. */
const MAX_RETURN_CHARS = 100_000

interface CacheEntry {
  content: string
  timestamp: number
  /** Is `content` the whole page, or only its first `MAX_RETURN_CHARS`? */
  complete: boolean
}

const CACHE_TTL = 15 * 60 * 1000 // 15 minutes
const cache = new Map<string, CacheEntry>()

/**
 * `complete` says whether `content` is the whole page or only its first
 * `MAX_RETURN_CHARS`. A caller asking past the end of an incomplete entry has to
 * re-fetch: answering from the cache would report "no more content" for a page
 * that has plenty, which is the same wrong answer a silently truncated read gave.
 */
function getCached(url: string, needFrom: number): CacheEntry | undefined {
  const entry = cache.get(url)
  if (!entry) return undefined
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(url)
    return undefined
  }
  if (!entry.complete && needFrom >= entry.content.length) return undefined
  return entry
}

function setCache(url: string, content: string, complete: boolean): void {
  // Evict oldest entries if cache grows too large (max 200 URLs)
  if (cache.size >= 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)
    for (let i = 0; i < 20 && oldest[i]; i++) {
      cache.delete(oldest[i]![0])
    }
  }
  cache.set(url, { content, timestamp: Date.now(), complete })
}

// ── HTTP→HTTPS upgrade ──

function upgradeToHttps(url: string): string {
  if (url.startsWith('http://')) {
    return url.replace('http://', 'https://')
  }
  return url
}

// ── HTML → Markdown conversion ──

function htmlToMarkdown(html: string, baseUrl: string): string {
  let text = html

  // Remove scripts, styles, nav, header, footer
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
  text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')

  // Convert headings
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, c) => `\n# ${stripTags(c).trim()}\n`)
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, c) => `\n## ${stripTags(c).trim()}\n`)
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, c) => `\n### ${stripTags(c).trim()}\n`)
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, c) => `\n#### ${stripTags(c).trim()}\n`)
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, c) => `\n##### ${stripTags(c).trim()}\n`)
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, c) => `\n###### ${stripTags(c).trim()}\n`)

  // Convert links: <a href="...">text</a> → [text](url)
  text = text.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, content) => {
    const resolved = resolveUrl(href, baseUrl)
    return `[${stripTags(content).trim()}](${resolved})`
  })

  // Convert images: <img ... src="..." ...> → ![alt](url)
  text = text.replace(
    /<img[^>]*src=["']([^"']*)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi,
    (_, src, alt) => {
      const resolved = resolveUrl(src, baseUrl)
      return `![${alt || ''}](${resolved})`
    },
  )
  text = text.replace(/<img[^>]*src=["']([^"']*)["'][^>]*\/?>/gi, (_, src) => {
    const resolved = resolveUrl(src, baseUrl)
    return `![](${resolved})`
  })

  // Convert lists
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `- ${stripTags(c).trim()}\n`)
  text = text.replace(/<\/ul>/gi, '\n')
  text = text.replace(/<\/ol>/gi, '\n')

  // Convert code blocks
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, c) => {
    const decoded = c
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
    return `\n\`\`\`\n${decoded.trim()}\n\`\`\`\n`
  })
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => `\`${c.trim()}\``)

  // Convert inline formatting
  text = text.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
  text = text.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
  text = text.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
  text = text.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')

  // Convert paragraph and line break tags
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/p>/gi, '\n\n')
  text = text.replace(/<p[^>]*>/gi, '')

  // Strip remaining HTML tags
  text = text.replace(/<[^>]*>/g, '')

  // Decode HTML entities
  text = text.replace(/&lt;/g, '<')
  text = text.replace(/&gt;/g, '>')
  text = text.replace(/&amp;/g, '&')
  text = text.replace(/&quot;/g, '"')
  text = text.replace(/&#x27;/g, "'")
  text = text.replace(/&#39;/g, "'")
  text = text.replace(/&nbsp;/g, ' ')

  // Collapse whitespace (preserve intentional line breaks)
  text = text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n')
  text = text.replace(/\n{3,}/g, '\n\n')

  return text.trim()
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

function resolveUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString()
  } catch {
    return href
  }
}

// ── Result rendering ──

/**
 * Render the requested window of `full`, with the header and a notice saying how
 * much of the page is *not* in this answer and which `offset` continues it.
 *
 * The notice is the point. A bare `... (truncated)` is indistinguishable from
 * "this was the whole page", so the caller reports a partial read as a complete
 * one; and without an `offset` to pass, everything past the first window was
 * permanently unreachable rather than merely unread.
 */
function withOffsetNotice(
  full: string,
  offset: number,
  prompt: string,
  url: string,
  complete: boolean,
): string {
  const header = prompt
    ? `── WebFetch: ${url} ──\nPrompt: ${prompt}\n\n`
    : `── WebFetch: ${url} ──\n\n`

  if (offset >= full.length) {
    return (
      header +
      `... (offset ${offset} is past the end: this page has ` +
      `${complete ? full.length : `at least ${full.length}`} characters)`
    )
  }

  const window = full.slice(offset, offset + MAX_RETURN_CHARS)
  const end = offset + window.length

  // Whole page, asked for from the start — nothing to qualify.
  if (complete && offset === 0 && end === full.length) return header + window

  const total = complete ? `${full.length}` : `at least ${full.length}`
  const remaining = complete ? full.length - end : undefined
  const notice =
    remaining === undefined
      ? `\n\n... (characters ${offset}–${end - 1} of ${total}; call again with offset=${end} for more)`
      : remaining > 0
        ? `\n\n... (characters ${offset}–${end - 1} of ${total}; ${remaining} unread — call again with offset=${end} for the next part)`
        : `\n\n... (characters ${offset}–${end - 1} of ${total}; end of page)`

  return header + window + notice
}

// ── Tool Definition ──

export const webFetchTool: ToolDefinition = {
  name: 'WebFetch',
  description:
    'Fetches a URL, converts the page to markdown. HTTP is upgraded to HTTPS. Cross-host redirects are returned to the caller. Responses are cached for 15 minutes per URL.',
  category: 'network',
  permission: 'self',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri', description: 'URL to fetch' },
      prompt: {
        type: 'string',
        description:
          'What to extract from the page (e.g., "find the API docs for authentication"). The tool returns the page content — truncated past 100,000 characters, with the omitted count stated — and the prompt helps focus extraction.',
      },
      offset: {
        type: 'integer',
        description:
          'Character offset to start reading from (default 0). A long page is returned 100,000 characters at a time; the truncation notice names the offset to pass next.',
      },
    },
    required: ['url'],
  },
  async execute(params, _ctx) {
    const rawUrl = params.url as string
    const prompt = (params.prompt as string) || ''
    const offset = Math.max(0, Number(params.offset) || 0)
    const url = upgradeToHttps(rawUrl)

    // Check cache — an incomplete entry (first 100k only) cannot answer a
    // request that starts past what it holds.
    const cached = getCached(url, offset)
    if (cached) {
      return {
        success: true,
        content: withOffsetNotice(cached.content, offset, prompt, url, cached.complete),
        metadata: { cached: true, url, offset },
      }
    }

    // SSRF protection: validate URL before fetching
    const validationError = await validateUrl(url)
    if (validationError) {
      return { success: false, content: '', error: validationError }
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000) // 30s timeout

      // Manual redirect handling: follow same-host redirects one hop at a time,
      // validating the target BEFORE each request (closes the SSRF-via-redirect gap).
      let currentUrl = url
      const originalHost = new URL(url).hostname
      let response!: Response

      for (let hop = 0; hop <= 5; hop++) {
        response = await fetch(currentUrl, {
          headers: {
            'User-Agent': `Mipham-Code/${PACKAGE_VERSION}`,
            Accept: 'text/html,application/xhtml+xml,*/*',
          },
          redirect: 'manual',
          signal: controller.signal,
        })

        // Not a redirect (or no Location) → proceed with this response
        if (response.status < 300 || response.status >= 400) break
        const location = response.headers.get('location')
        if (!location || hop === 5) break

        const nextUrl = new URL(location, currentUrl).toString()

        // SSRF defense: validate the redirect target BEFORE following
        const redirectError = await validateUrl(nextUrl)
        if (redirectError) {
          clearTimeout(timer)
          return {
            success: false,
            content: '',
            error: `Redirect blocked: ${redirectError}`,
          }
        }

        // Cross-host redirects are returned to the caller (tool contract)
        if (new URL(nextUrl).hostname !== originalHost) {
          clearTimeout(timer)
          return {
            success: true,
            content: `Redirected to: ${nextUrl}\n\nFetch from this URL directly to retrieve content.`,
            metadata: { redirected: true, originalUrl: url, finalUrl: nextUrl },
          }
        }

        currentUrl = nextUrl
      }

      clearTimeout(timer)

      // Determine content type; only convert HTML to markdown
      const contentType = response.headers.get('content-type') || ''
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml')

      if (!response.ok) {
        return {
          success: false,
          content: '',
          error: `HTTP ${response.status}: ${response.statusText}`,
        }
      }

      let content: string

      if (isHtml) {
        const html = await response.text()
        const baseUrl = response.url || url
        content = htmlToMarkdown(html, baseUrl)
      } else {
        // Plain text / JSON / etc. — return as-is
        content = await response.text()
      }

      // Cache the first window. The cache stays the size it always was (one
      // `MAX_RETURN_CHARS` per URL) — `complete` is what lets a later `offset`
      // tell "this is the whole page" apart from "this is the first slice of it",
      // and re-fetch when it needs more.
      const complete = content.length <= MAX_RETURN_CHARS
      setCache(url, content.slice(0, MAX_RETURN_CHARS), complete)

      return {
        success: true,
        content: withOffsetNotice(content, offset, prompt, url, complete),
        metadata: { url, offset, totalSize: content.length },
      }
    } catch (err) {
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? 'Request timed out (30s)'
          : `Fetch failed: ${String(err)}. If direct network is blocked, retry via the web-access skill (CDP through the user's logged-in Chrome).`
      return { success: false, content: '', error: message }
    }
  },
}
