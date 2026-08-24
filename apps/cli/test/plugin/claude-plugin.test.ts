import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { detectPluginFormat, validatePlugin } from '../../src/plugin/plugin-validator'
import { readClaudeManifest, loadClaudePlugin } from '../../src/plugin/claude-plugin'
import { SkillsLoader } from '../../src/skills/loader'
import { AgentRegistry } from '../../src/agent/agent-registry'
import type { McpServerConfig, ToolDefinition } from '../../src/shared/types'

const TEST_HOME = join(tmpdir(), 'mipham-claude-plugin-' + Date.now())

function createClaudePlugin(name: string, extra?: (dir: string) => void): string {
  const dir = join(TEST_HOME, name)
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0' }, null, 2),
    'utf-8',
  )
  extra?.(dir)
  return dir
}

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('detectPluginFormat', () => {
  it('detects Claude plugins via .claude-plugin/plugin.json', () => {
    const dir = createClaudePlugin('detect-claude')
    expect(detectPluginFormat(dir)).toBe('claude')
  })

  it('detects Mipham plugins via plugin.json', () => {
    const dir = join(TEST_HOME, 'detect-mipham')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'm', version: '1.0.0' }))
    expect(detectPluginFormat(dir)).toBe('mipham')
  })

  it('defaults to mipham when no manifest is present', () => {
    const dir = join(TEST_HOME, 'detect-empty')
    mkdirSync(dir, { recursive: true })
    expect(detectPluginFormat(dir)).toBe('mipham')
  })
})

describe('validatePlugin (Claude)', () => {
  it('accepts a Claude plugin with only a name (no version required)', () => {
    const dir = join(TEST_HOME, 'valid-claude')
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'claude-only' }),
    )
    const result = validatePlugin(dir)
    expect(result.valid).toBe(true)
    expect(result.format).toBe('claude')
    expect(result.manifest?.name).toBe('claude-only')
  })

  it('rejects a Claude plugin with an invalid name', () => {
    const dir = createClaudePlugin('Invalid Name!')
    const result = validatePlugin(dir)
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toContain('Invalid plugin name')
  })
})

describe('readClaudeManifest', () => {
  it('reads the .claude-plugin/plugin.json manifest', () => {
    const dir = createClaudePlugin('read-manifest')
    const manifest = readClaudeManifest(dir)
    expect(manifest?.name).toBe('read-manifest')
    expect(manifest?.version).toBe('1.0.0')
  })

  it('returns null when no manifest exists', () => {
    const dir = join(TEST_HOME, 'read-empty')
    mkdirSync(dir, { recursive: true })
    expect(readClaudeManifest(dir)).toBeNull()
  })
})

describe('loadClaudePlugin', () => {
  function stubDeps() {
    return {
      skillsLoader: new SkillsLoader(),
      agentRegistry: new AgentRegistry(),
      mcpClient: {
        connect: async (_config: McpServerConfig) => undefined,
        disconnect: () => [] as string[],
      },
      toolsMap: new Map<string, ToolDefinition>(),
    }
  }

  it('loads skills from skills/<name>/SKILL.md', () => {
    const dir = createClaudePlugin('with-skills', (d) => {
      const skillDir = join(d, 'skills', 'foo')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        '---\nname: foo\ndescription: Does foo things\n---\n\nBody here.\n',
        'utf-8',
      )
    })

    const deps = stubDeps()
    loadClaudePlugin(dir, deps)

    expect(deps.skillsLoader.has('foo')).toBe(true)
    expect(deps.skillsLoader.get('foo')?.description).toContain('foo')
  })

  it('loads agents from agents/*.md', () => {
    const dir = createClaudePlugin('with-agents', (d) => {
      const agentsDir = join(d, 'agents')
      mkdirSync(agentsDir, { recursive: true })
      writeFileSync(
        join(agentsDir, 'reviewer.md'),
        '---\nname: reviewer\ndescription: Reviews code\n---\n\nYou review code.\n',
        'utf-8',
      )
    })

    const deps = stubDeps()
    loadClaudePlugin(dir, deps)

    expect(deps.agentRegistry.get('reviewer')?.description).toBe('Reviews code')
  })

  it('loads stdio MCP servers from .mcp.json with ${CLAUDE_PLUGIN_ROOT} expanded', () => {
    const dir = createClaudePlugin('with-mcp', (d) => {
      writeFileSync(
        join(d, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            'my-server': {
              type: 'stdio',
              command: '${CLAUDE_PLUGIN_ROOT}/bin/server',
              args: ['--root', '${CLAUDE_PLUGIN_ROOT}/data'],
            },
          },
        }),
        'utf-8',
      )
    })

    const connected: McpServerConfig[] = []
    const deps = stubDeps()
    deps.mcpClient.connect = async (config: McpServerConfig) => {
      connected.push(config)
    }

    const names = loadClaudePlugin(dir, deps)

    expect(names).toEqual(['my-server'])
    expect(connected).toHaveLength(1)
    expect(connected[0]!.command).toBe(join(dir, 'bin/server'))
    expect(connected[0]!.args).toEqual(['--root', join(dir, 'data')])
  })

  it('returns no MCP servers when a Claude plugin has none', () => {
    const dir = createClaudePlugin('no-mcp')
    const deps = stubDeps()
    expect(loadClaudePlugin(dir, deps)).toEqual([])
  })
})
