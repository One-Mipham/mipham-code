import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validatePlugin } from '../../src/plugin/plugin-validator'

/**
 * `validatePlugin` is the only place a plugin's declaration is read *before* it is
 * installed, so anything it stays quiet about is something the operator finds out
 * from behaviour — or never finds out at all. These tests pin the three ways an
 * MCP declaration fails to reach the world: it is dropped by the loader, it names
 * a value nothing substitutes, or it is sent in the clear.
 *
 * The two formats are covered separately on purpose — each has its own loader, and
 * a check that read the other format's file would be reporting on a file nothing
 * reads at all.
 *
 * Every finding is a **warning**, not an error: the plugin still installs. A
 * declaration we would drop is a defect in one part of one plugin, not grounds to
 * reject the whole thing.
 */

const ROOT = join(tmpdir(), 'mipham-validator-test-' + process.pid)

let seq = 0
function newDir(): string {
  const dir = join(ROOT, `p${++seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A Mipham-format plugin: `plugin.json` + `mcp-servers/*.json`. */
function makePlugin(build?: (dir: string) => void): string {
  const dir = newDir()
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({ name: `p${seq}`, version: '1.0.0' }),
    'utf-8',
  )
  build?.(dir)
  return dir
}

/** A Claude marketplace plugin: `.claude-plugin/plugin.json` + `.mcp.json`. */
function makeClaudePlugin(build?: (dir: string) => void): string {
  const dir = newDir()
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: `c${seq}` }),
    'utf-8',
  )
  build?.(dir)
  return dir
}

function writeMcpJson(dir: string, servers: Record<string, unknown> | string): void {
  const body = typeof servers === 'string' ? servers : JSON.stringify({ mcpServers: servers })
  writeFileSync(join(dir, '.mcp.json'), body, 'utf-8')
}

function writeMcpServer(dir: string, file: string, cfg: Record<string, unknown> | string): void {
  const mcpDir = join(dir, 'mcp-servers')
  mkdirSync(mcpDir, { recursive: true })
  writeFileSync(join(mcpDir, file), typeof cfg === 'string' ? cfg : JSON.stringify(cfg), 'utf-8')
}

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('validatePlugin — declarations the loader would drop', () => {
  it('reports an .mcp.json entry with no transport', () => {
    const dir = makeClaudePlugin((d) => writeMcpJson(d, { broken: { type: 'stdio' } }))
    const joined = validatePlugin(dir).warnings.join('\n')

    expect(joined).toContain('broken')
    expect(joined).toContain('neither command nor url')
  })

  it('reports a mipham mcp-servers/ entry with no transport', () => {
    const dir = makePlugin((d) => writeMcpServer(d, 's.json', { name: 'local' }))
    const joined = validatePlugin(dir).warnings.join('\n')

    expect(joined).toContain('local')
    expect(joined).toContain('neither command nor url')
  })

  it('stays quiet on a url-only entry, which the loader does load', () => {
    // The counterpart of the two tests above, and the reason they exist: a check
    // that fired on *every* entry would pass them and mean nothing. A remote server
    // is declared by `url` alone — `McpServerConfig` makes the two fields mutually
    // exclusive, so requiring `command` is precisely what used to drop it.
    const claude = makeClaudePlugin((d) =>
      writeMcpJson(d, { remote: { type: 'http', url: 'https://example.com/mcp' } }),
    )
    const mipham = makePlugin((d) =>
      writeMcpServer(d, 's.json', { name: 'remote', url: 'https://example.com/mcp' }),
    )

    expect(validatePlugin(claude).warnings).toEqual([])
    expect(validatePlugin(mipham).warnings).toEqual([])
  })

  it('reports an .mcp.json file that could not be parsed', () => {
    const dir = makeClaudePlugin((d) => writeMcpJson(d, '{ not json'))
    expect(validatePlugin(dir).warnings.join('\n')).toContain('could not be parsed')
  })

  it('reports a mcp-servers/ file that could not be parsed', () => {
    const dir = makePlugin((d) => writeMcpServer(d, 's.json', '{ not json'))
    expect(validatePlugin(dir).warnings.join('\n')).toContain('could not be parsed')
  })

  it('reports every dropped entry, not just the first', () => {
    const dir = makeClaudePlugin((d) =>
      writeMcpJson(d, { one: { type: 'stdio' }, two: { type: 'http' } }),
    )
    const joined = validatePlugin(dir).warnings.join('\n')
    expect(joined).toContain('one')
    expect(joined).toContain('two')
  })
})

describe('validatePlugin — references that resolve to nothing', () => {
  it('reports a ${user_config.*} reference, which this loader never substitutes', () => {
    const dir = makeClaudePlugin((d) =>
      writeMcpJson(d, {
        remote: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer ${user_config.api_token}' },
        },
      }),
    )
    const joined = validatePlugin(dir).warnings.join('\n')

    // Named by key: the operator has to know *which* value is being sent as the
    // literal text `${user_config.api_token}` to fix it.
    expect(joined).toContain('user_config.api_token')
  })

  it('reports a ${user_config.*} reference in the manifest itself', () => {
    const dir = makePlugin((d) => {
      writeFileSync(
        join(d, 'plugin.json'),
        JSON.stringify({
          name: `p${seq}`,
          version: '1.0.0',
          mcpServers: { remote: { url: 'https://${user_config.host}/mcp' } },
        }),
        'utf-8',
      )
    })
    expect(validatePlugin(dir).warnings.join('\n')).toContain('user_config.host')
  })

  it('reports one warning per distinct key, however often it appears', () => {
    const dir = makeClaudePlugin((d) =>
      writeMcpJson(d, {
        a: { url: 'https://one.example/${user_config.token}' },
        b: { url: 'https://two.example/${user_config.token}' },
      }),
    )
    const hits = validatePlugin(dir).warnings.filter((w) => w.includes('user_config.token'))
    expect(hits).toHaveLength(1)
  })
})

describe('validatePlugin — transport security', () => {
  it('reports a cleartext remote URL', () => {
    const dir = makeClaudePlugin((d) =>
      writeMcpJson(d, { remote: { type: 'http', url: 'http://mcp.example.com/mcp' } }),
    )
    expect(validatePlugin(dir).warnings.join('\n')).toContain('cleartext')
  })

  it('accepts cleartext to the loopback address, where there is no network to secure', () => {
    // A local MCP server on `http://127.0.0.1:3000` is the ordinary way to run one
    // during development. Firing here would train the operator to ignore the check.
    for (const url of [
      'http://127.0.0.1:3000/mcp',
      'http://localhost:3000/mcp',
      'http://[::1]:3000/mcp',
    ]) {
      const dir = makeClaudePlugin((d) => writeMcpJson(d, { remote: { url } }))
      expect(validatePlugin(dir).warnings, url).toEqual([])
    }
  })

  it('accepts an https URL', () => {
    const dir = makeClaudePlugin((d) =>
      writeMcpJson(d, { remote: { url: 'https://mcp.example.com/mcp' } }),
    )
    expect(validatePlugin(dir).warnings).toEqual([])
  })
})

describe('validatePlugin — warnings do not reject the plugin', () => {
  it('stays valid while reporting a dropped declaration', () => {
    const dir = makeClaudePlugin((d) => writeMcpJson(d, { broken: { type: 'stdio' } }))
    const result = validatePlugin(dir)

    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('reports nothing for a plugin with no MCP declaration at all', () => {
    expect(validatePlugin(makePlugin()).warnings).toEqual([])
    expect(validatePlugin(makeClaudePlugin()).warnings).toEqual([])
  })
})
