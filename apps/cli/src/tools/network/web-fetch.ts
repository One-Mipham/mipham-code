import type { ToolDefinition } from '../shared/index.ts'
import { validateUrl } from '../../security/url'

export const webFetchTool: ToolDefinition = {
  name: 'WebFetch',
  description: 'Fetch content from a URL and process into markdown.',
  category: 'network',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri', description: 'URL to fetch' },
      prompt: { type: 'string', description: 'Prompt to run on fetched content' },
    },
    required: ['url'],
  },
  async execute(params, _ctx) {
    const url = params.url as string

    // SSRF protection: validate URL before fetching
    const validationError = validateUrl(url)
    if (validationError) {
      return { success: false, content: '', error: validationError }
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000) // 30s timeout

      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mipham-Code/0.1.0' },
        redirect: 'follow',
        signal: controller.signal,
      })

      clearTimeout(timer)

      if (!response.ok) {
        return {
          success: false,
          content: '',
          error: `HTTP ${response.status}: ${response.statusText}`,
        }
      }
      const html = await response.text()
      // Simple HTML-to-text extraction
      const text = html
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 50_000)
      return { success: true, content: text }
    } catch (err) {
      const message = err instanceof Error && err.name === 'AbortError'
        ? 'Request timed out (30s)'
        : `Fetch failed: ${String(err)}`
      return { success: false, content: '', error: message }
    }
  },
}
