import { describe, it, expect } from 'vitest'
import { formatMcpConnectFailures } from '../../src/mcp/connect-failures.js'

describe('formatMcpConnectFailures', () => {
  it('returns empty for no failures', () => {
    expect(formatMcpConnectFailures([])).toBe('')
  })

  it('lists failed server names and reasons', () => {
    const notice = formatMcpConnectFailures([
      { name: 'github', reason: 'connect ECONNREFUSED 127.0.0.1:8080' },
      { name: 'filesystem', reason: 'spawn ENOENT' },
    ])
    expect(notice).toContain('failed to connect')
    expect(notice).toContain('github')
    expect(notice).toContain('ECONNREFUSED')
    expect(notice).toContain('filesystem')
    expect(notice).toContain('spawn ENOENT')
  })
})
