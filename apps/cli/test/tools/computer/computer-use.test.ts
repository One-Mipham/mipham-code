import { describe, it, expect, vi, beforeEach } from 'vitest'
import { writeFileSync } from 'node:fs'
import type { ToolContext } from '@mipham/shared'

// Mock node:child_process to prevent real command execution
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => Buffer.from('')),
}))

import { execSync } from 'node:child_process'
import { computerUseTool } from '../../../src/tools/computer/computer-use'

const mockExecSync = execSync as ReturnType<typeof vi.fn>

// ── Test context ──

const ctx: ToolContext = {
  cwd: '/tmp/test',
  sessionId: 'test-session',
  provider: 'test',
  model: 'test-model',
}

// Minimal 1x1 valid PNG
const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// ============================================================
// ComputerUse Tool Definition
// ============================================================

describe('ComputerUse tool definition', () => {
  it('has correct metadata', () => {
    expect(computerUseTool.name).toBe('ComputerUse')
    expect(computerUseTool.category).toBe('system')
    expect(computerUseTool.permission).toBe('ask')
  })

  it('requires action parameter', () => {
    const params = computerUseTool.parameters as { required: string[] }
    expect(params.required).toEqual(['action'])
  })

  it('has all 5 actions in the enum', () => {
    const params = computerUseTool.parameters as {
      properties: { action: { enum: string[] } }
    }
    expect(params.properties.action.enum).toContain('screenshot')
    expect(params.properties.action.enum).toContain('launch')
    expect(params.properties.action.enum).toContain('browser_navigate')
    expect(params.properties.action.enum).toContain('browser_snapshot')
    expect(params.properties.action.enum).toContain('browser_click')
    expect(params.properties.action.enum).toHaveLength(5)
  })

  it('has optional target and text parameters', () => {
    const params = computerUseTool.parameters as {
      properties: Record<string, unknown>
    }
    expect(params.properties).toHaveProperty('target')
    expect(params.properties).toHaveProperty('text')
  })

  it('has a description mentioning security requirement', () => {
    expect(computerUseTool.description).toContain('user approval')
  })
})

// ============================================================
// ComputerUse Tool Execution
// ============================================================

describe('ComputerUse tool execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns error for unknown action', async () => {
    const result = await computerUseTool.execute({ action: 'unknown_action' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown action')
  })

  it('returns error when action is missing', async () => {
    const result = await computerUseTool.execute({}, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown action')
  })

  // ── Screenshot ──

  describe('screenshot action', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('returns success with screenshot data', async () => {
      // Make execSync write a minimal PNG to the temp file path
      mockExecSync.mockImplementation((cmd: string) => {
        const match = cmd.toString().match(/screencapture -x (.+)/)
        if (match) {
          writeFileSync(match[1]!, Buffer.from(MINIMAL_PNG_BASE64, 'base64'))
        }
        return Buffer.from('')
      })

      const result = await computerUseTool.execute({ action: 'screenshot' }, ctx)
      expect(result.success).toBe(true)
      expect(result.content).toContain('Screenshot captured')
    })

    it('returns error when platform command fails', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('screencapture not found')
      })

      const result = await computerUseTool.execute({ action: 'screenshot' }, ctx)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Screenshot failed')
    })
  })

  // ── App Launch ──

  describe('launch action', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('rejects apps not in the allowed list', async () => {
      const result = await computerUseTool.execute(
        { action: 'launch', target: 'MaliciousApp' },
        ctx,
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('not in the allowed list')
    })

    it('allows apps in the allowed list', async () => {
      mockExecSync.mockReturnValue(Buffer.from(''))

      const result = await computerUseTool.execute({ action: 'launch', target: 'Safari' }, ctx)
      expect(result.success).toBe(true)
      expect(result.content).toContain('Launched: Safari')
    })

    it('validates each allowed app is accepted', async () => {
      mockExecSync.mockReturnValue(Buffer.from(''))

      const allowedApps = [
        'Finder',
        'Safari',
        'Google Chrome',
        'Firefox',
        'Terminal',
        'VS Code',
        'System Settings',
        'Activity Monitor',
        'TextEdit',
        'Preview',
      ]

      for (const app of allowedApps) {
        const result = await computerUseTool.execute({ action: 'launch', target: app }, ctx)
        expect(result.success).toBe(true)
        expect(result.content).toContain(`Launched: ${app}`)
      }
    })

    it('returns error when target is empty for launch', async () => {
      const result = await computerUseTool.execute({ action: 'launch', target: '' }, ctx)
      expect(result.success).toBe(false)
      expect(result.error).toContain('not in the allowed list')
    })
  })

  // ── Browser Actions ──

  describe('browser actions (no Playwright installed)', () => {
    it('returns error for browser_navigate when playwright not available', async () => {
      const result = await computerUseTool.execute(
        { action: 'browser_navigate', target: 'https://example.com' },
        ctx,
      )
      expect(result.success).toBe(false)
    })

    it('returns error for browser_snapshot when playwright not available', async () => {
      const result = await computerUseTool.execute({ action: 'browser_snapshot' }, ctx)
      expect(result.success).toBe(false)
    })

    it('returns error for browser_click when playwright not available', async () => {
      const result = await computerUseTool.execute(
        { action: 'browser_click', target: 'element-1' },
        ctx,
      )
      expect(result.success).toBe(false)
    })
  })
})
