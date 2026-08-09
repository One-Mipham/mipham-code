import type { ToolDefinition } from '../../shared/index.ts'

/**
 * Brave Search API integration.
 *
 * API: https://api.search.brave.com/res/v1/web/search
 * Free tier: 2000 queries/month (no credit card required)
 * Sign up: https://brave.com/search/api/
 *
 * Set BRAVE_API_KEY in your environment to enable web search.
 * Falls back to a helpful message when the key is not configured.
 */

const BRAVE_API = 'https://api.search.brave.com/res/v1/web/search'
const MAX_RESULTS = 10

interface BraveWebResult {
  title: string
  url: string
  description: string
}

interface BraveAPIResponse {
  web?: {
    results?: BraveWebResult[]
  }
}

function getApiKey(): string | undefined {
  return process.env.BRAVE_API_KEY || undefined
}

function filterByDomains(
  results: BraveWebResult[],
  allowed?: string[],
  blocked?: string[],
): BraveWebResult[] {
  let filtered = results

  if (allowed && allowed.length > 0) {
    filtered = filtered.filter((r) => {
      try {
        const host = new URL(r.url).hostname
        return allowed.some((d) => host === d || host.endsWith('.' + d))
      } catch {
        return false
      }
    })
  }

  if (blocked && blocked.length > 0) {
    filtered = filtered.filter((r) => {
      try {
        const host = new URL(r.url).hostname
        return !blocked.some((d) => host === d || host.endsWith('.' + d))
      } catch {
        return true
      }
    })
  }

  return filtered
}

function formatResults(results: BraveWebResult[]): string {
  if (results.length === 0) {
    return 'No results found.'
  }

  return results
    .map((r, i) => {
      const title = r.title.replace(/\n/g, ' ').trim()
      const desc = (r.description || '').replace(/\n/g, ' ').trim()
      return `${i + 1}. **${title}**\n   ${r.url}\n   ${desc}`
    })
    .join('\n\n')
}

export const webSearchTool: ToolDefinition = {
  name: 'WebSearch',
  description:
    'Search the web via Brave Search API. Returns result blocks with titles, URLs, and descriptions. Set BRAVE_API_KEY to enable.',
  category: 'network',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 2, description: 'Search query' },
      allowed_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only include results from these domains',
      },
      blocked_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Never include results from these domains',
      },
    },
    required: ['query'],
  },
  async execute(params, _ctx) {
    const query = params.query as string
    const allowedDomains = params.allowed_domains as string[] | undefined
    const blockedDomains = params.blocked_domains as string[] | undefined

    const apiKey = getApiKey()
    if (!apiKey) {
      return {
        success: true,
        content: [
          '── Web Search (not configured) ──',
          '',
          `Query: "${query}"`,
          '',
          'Web search is not yet configured. To enable it:',
          '',
          '1. Get a free API key at https://brave.com/search/api/',
          '   (2,000 queries/month, no credit card required)',
          '',
          '2. Set the key in your environment:',
          '   export BRAVE_API_KEY="BSA..."',
          '',
          '3. Restart Mipham Code and try again.',
          '',
          'Alternatives (add API key for any):',
          '   TAVILY_API_KEY   — https://tavily.com',
          '   SERPAPI_API_KEY  — https://serpapi.com',
        ].join('\n'),
      }
    }

    try {
      const url = new URL(BRAVE_API)
      url.searchParams.set('q', query)
      url.searchParams.set('count', String(MAX_RESULTS))

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000) // 15s timeout

      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
        signal: controller.signal,
      })

      clearTimeout(timer)

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        // 429 = rate limit, 401 = bad key
        if (response.status === 429) {
          return {
            success: false,
            content: '',
            error: 'Brave Search API rate limit reached (2,000/month on free tier). Try again later.',
          }
        }
        if (response.status === 401) {
          return {
            success: false,
            content: '',
            error: 'Invalid BRAVE_API_KEY. Check your key at https://brave.com/search/api/.',
          }
        }
        return {
          success: false,
          content: '',
          error: `Brave Search API error (${response.status}): ${body.slice(0, 200)}`,
        }
      }

      const data = (await response.json()) as BraveAPIResponse
      const rawResults = data.web?.results || []

      const filtered = filterByDomains(rawResults, allowedDomains, blockedDomains)
      const formatted = formatResults(filtered)

      return {
        success: true,
        content: [
          `── Web Search: "${query}" ──`,
          `${filtered.length} result(s)`,
          '',
          formatted,
          '',
          rawResults.length > filtered.length
            ? `(${rawResults.length - filtered.length} result(s) filtered by domain rules)`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      }
    } catch (err) {
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? 'Search timed out (15s). Try a more specific query.'
          : `Search failed: ${String(err)}`
      return { success: false, content: '', error: message }
    }
  },
}
