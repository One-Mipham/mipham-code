import type { ToolDefinition } from '../../shared/index.ts'
import { validateUrl } from '../../security/url'

// ── In-memory cache (15-min TTL per URL) ──

interface CacheEntry {
  content: string
  timestamp: number
}

const CACHE_TTL = 15 * 60 * 1000 // 15 minutes
const cache = new Map<string, CacheEntry>()

function getCached(url: string): string | undefined {
  const entry = cache.get(url)
  if (!entry) return undefined
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(url)
    return undefined
  }
  return entry.content
}

function setCache(url: string, content: string): void {
  // Evict oldest entries if cache grows too large (max 200 URLs)
  if (cache.size >= 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)
    for (let i = 0; i < 20 && oldest[i]; i++) {
      cache.delete(oldest[i]![0])
    }
  }
  cache.set(url, { content, timestamp: Date.now() })
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
  text = text.replace(/<img[^>]*src=["']([^"']*)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi,
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

// ── Tool Definition ──

export const webFetchTool: ToolDefinition = {
  name: 'WebFetch',
  description:
    'Fetches a URL, converts the page to markdown. HTTP is upgraded to HTTPS. Cross-host redirects are returned to the caller. Responses are cached for 15 minutes per URL.',
  category: 'network',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri', description: 'URL to fetch' },
      prompt: {
        type: 'string',
        description:
          'What to extract from the page (e.g., "find the API docs for authentication"). The tool returns the full page; the prompt helps focus extraction.',
      },
    },
    required: ['url'],
  },
  async execute(params, _ctx) {
    const rawUrl = params.url as string
    const prompt = (params.prompt as string) || ''
    const url = upgradeToHttps(rawUrl)

    // Check cache
    const cached = getCached(url)
    if (cached) {
      return {
        success: true,
        content: cached,
        metadata: { cached: true, url },
      }
    }

    // SSRF protection: validate URL before fetching
    const validationError = validateUrl(url)
    if (validationError) {
      return { success: false, content: '', error: validationError }
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000) // 30s timeout

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mipham-Code/0.24.0',
          Accept: 'text/html,application/xhtml+xml,*/*',
        },
        redirect: 'follow',
        signal: controller.signal,
      })

      clearTimeout(timer)

      // Cross-host redirect reporting
      if (response.url) {
        const finalHost = new URL(response.url).hostname
        const originalHost = new URL(url).hostname
        if (finalHost !== originalHost) {
          return {
            success: true,
            content: `Redirected to: ${response.url}\n\nFetch from this URL directly to retrieve content.`,
            metadata: { redirected: true, originalUrl: url, finalUrl: response.url },
          }
        }

        // SSRF defense: re-validate the resolved URL after redirects
        const redirectError = validateUrl(response.url)
        if (redirectError) {
          return {
            success: false,
            content: '',
            error: `Redirect blocked: ${redirectError}`,
          }
        }
      }

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

      // Truncate to 100K characters
      if (content.length > 100_000) {
        content = content.slice(0, 100_000) + '\n\n... (truncated)'
      }

      // Cache the result
      setCache(url, content)

      // Include prompt context if provided
      const header = prompt
        ? `── WebFetch: ${url} ──\nPrompt: ${prompt}\n\n`
        : `── WebFetch: ${url} ──\n\n`

      return { success: true, content: header + content, metadata: { url, size: content.length } }
    } catch (err) {
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? 'Request timed out (30s)'
          : `Fetch failed: ${String(err)}`
      return { success: false, content: '', error: message }
    }
  },
}
