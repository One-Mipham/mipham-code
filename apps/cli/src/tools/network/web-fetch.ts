import type { ToolDefinition } from '@mipham/shared'

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
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mipham-Code/0.1.0' },
        redirect: 'follow',
      })
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
      return { success: false, content: '', error: `Fetch failed: ${String(err)}` }
    }
  },
}
