import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Isolate the trust store from the real ~/.mipham — this test rmSync's
// trusted-workspaces.json, which would otherwise wipe a real user's trust list.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-workspace-trust`,
  }
})

import {
  rmSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import {
  WorkspaceTrust,
  getWorkspaceTrust,
  resetWorkspaceTrust,
  warnProjectHooksSkipped,
} from '../../src/core/workspace-trust'

const TRUST_STORE_PATH = join(homedir(), '.mipham', 'trusted-workspaces.json')

describe('WorkspaceTrust', () => {
  let trust: WorkspaceTrust

  beforeEach(() => {
    // Remove existing trust store for clean state
    try {
      rmSync(TRUST_STORE_PATH, { force: true })
    } catch {}
    resetWorkspaceTrust()
    trust = new WorkspaceTrust()
  })

  afterEach(() => {
    try {
      rmSync(TRUST_STORE_PATH, { force: true })
    } catch {}
  })

  it('starts with empty trust list', () => {
    expect(trust.listTrusted()).toEqual([])
  })

  it('版本对了但 directories 缺失/形状不对时按空信任表处理，而不是抛', () => {
    // 原先只查 `version !== 1`：`{ version: 1 }` 过闸，随后
    // `for (const trusted of this.store.directories)` 在 isTrusted 上抛。
    // 非字符串项同理 —— isTrusted 对每一项调 `.toLowerCase()`。
    mkdirSync(join(homedir(), '.mipham'), { recursive: true })

    for (const bad of [
      '{"version":1}',
      '{"version":1,"directories":null}',
      '{"version":1,"directories":[1]}',
    ]) {
      writeFileSync(TRUST_STORE_PATH, bad, 'utf-8')
      resetWorkspaceTrust()
      const t = new WorkspaceTrust()
      expect(t.listTrusted()).toEqual([])
      expect(t.isTrusted('/tmp')).toBe(false)
    }
  })

  it('合法信任表仍然照常读出来（正控：上面的判据不是恒真的）', () => {
    // realpathSync: trust() 存的是 realpath（macOS 上 /tmp → /private/tmp），
    // 拿原始路径断言会红在一个与形状校验无关的原因上。
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trust-ok-')))
    const t = new WorkspaceTrust()
    t.trust(dir)
    resetWorkspaceTrust()
    expect(new WorkspaceTrust().listTrusted()).toEqual([dir])
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  it('写入是原子的（换 inode），且不留临时文件', () => {
    // 这张表的读侧把「读不出来」吞成**空信任表**（load 的 catch），所以写到一半
    // 被打断不是「丢一条记录」，而是静默把用户批准过的每个目录都退回未信任。
    // 权限与「无 .tmp 残骸」都证明不了原子性：裸 writeFileSync 原地截断，inode 不变。
    const dir1 = join(tmpdir(), 'atomic-trust-a')
    const dir2 = join(tmpdir(), 'atomic-trust-b')
    mkdirSync(dir1, { recursive: true })
    mkdirSync(dir2, { recursive: true })

    trust.trust(dir1)
    const before = statSync(TRUST_STORE_PATH).ino
    trust.trust(dir2)

    // 正控：内容真的变了（否则 inode 那条判据可能只是因为压根没写）
    expect(new WorkspaceTrust().listTrusted()).toHaveLength(2)
    expect(statSync(TRUST_STORE_PATH).ino).not.toBe(before)
    expect(readdirSync(join(homedir(), '.mipham')).filter((f) => f.includes('.tmp'))).toEqual([])
  })

  it('trusts a directory', () => {
    const dir = join(tmpdir(), 'trusted-project')
    mkdirSync(dir, { recursive: true })

    trust.trust(dir)
    expect(trust.isTrusted(dir)).toBe(true)
    expect(trust.listTrusted()).toContain(dir)
  })

  it('untrusts a directory', () => {
    const dir = join(tmpdir(), 'untrust-me')
    mkdirSync(dir, { recursive: true })

    trust.trust(dir)
    expect(trust.isTrusted(dir)).toBe(true)

    trust.untrust(dir)
    expect(trust.isTrusted(dir)).toBe(false)
  })

  it('trusts subdirectories of trusted paths (hierarchical trust)', () => {
    const parent = join(tmpdir(), 'parent-workspace')
    const child = join(parent, 'sub-project')
    mkdirSync(child, { recursive: true })

    trust.trust(parent)
    expect(trust.isTrusted(parent)).toBe(true)
    expect(trust.isTrusted(child)).toBe(true)
  })

  it('does not trust nested git repos under a trusted directory', () => {
    const outer = join(tmpdir(), 'outer-repo')
    const nested = join(outer, 'vendor', 'dep')
    const sibling = join(outer, 'src')
    mkdirSync(nested, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    // Mark outer and the nested dir as separate git-repo roots.
    mkdirSync(join(outer, '.git'), { recursive: true })
    mkdirSync(join(nested, '.git'), { recursive: true })

    trust.trust(outer)
    // Same-repo subdir is still trusted…
    expect(trust.isTrusted(sibling)).toBe(true)
    // …but the nested repo (and anything under it) is isolated.
    expect(trust.isTrusted(nested)).toBe(false)
    expect(trust.isTrusted(join(nested, 'src'))).toBe(false)
  })

  it('does not trust sibling directories', () => {
    const dir1 = join(tmpdir(), 'project-a')
    const dir2 = join(tmpdir(), 'project-b')
    mkdirSync(dir1, { recursive: true })
    mkdirSync(dir2, { recursive: true })

    trust.trust(dir1)
    expect(trust.isTrusted(dir1)).toBe(true)
    expect(trust.isTrusted(dir2)).toBe(false)
  })

  it('does not trust parent of trusted subdirectory', () => {
    const parent = join(tmpdir(), 'outer')
    const child = join(parent, 'inner')
    mkdirSync(child, { recursive: true })

    trust.trust(child)
    expect(trust.isTrusted(child)).toBe(true)
    expect(trust.isTrusted(parent)).toBe(false)
  })

  it('is case-insensitive for trust checks', () => {
    const dir = join(tmpdir(), 'MyProject')
    mkdirSync(dir, { recursive: true })

    trust.trust(dir)
    expect(trust.isTrusted(dir.toUpperCase())).toBe(true)
    expect(trust.isTrusted(dir.toLowerCase())).toBe(true)
  })

  it('does not add duplicate entries', () => {
    const dir = join(tmpdir(), 'no-dup')
    mkdirSync(dir, { recursive: true })

    trust.trust(dir)
    trust.trust(dir)
    trust.trust(dir)
    expect(trust.listTrusted().length).toBe(1)
  })

  it('persists trust store to disk', () => {
    const dir = join(tmpdir(), 'persisted')
    mkdirSync(dir, { recursive: true })

    trust.trust(dir)
    expect(existsSync(TRUST_STORE_PATH)).toBe(true)

    // Create a new instance — should load from disk
    const trust2 = new WorkspaceTrust()
    expect(trust2.isTrusted(dir)).toBe(true)
  })

  it('untrust removes subdirectories too', () => {
    const parent = join(tmpdir(), 'to-remove')
    const child = join(parent, 'nested')
    mkdirSync(child, { recursive: true })

    // Trust child first, then parent — both get explicit entries
    trust.trust(child)
    trust.trust(parent)
    // Parent was added, child already covered by parent's hierarchical trust
    expect(trust.listTrusted()).toHaveLength(2)

    trust.untrust(parent)
    // Both parent and child entries should be removed
    expect(trust.isTrusted(parent)).toBe(false)
    expect(trust.isTrusted(child)).toBe(false)
    expect(trust.listTrusted()).toHaveLength(0)
  })

  it('survives corrupt trust store file', () => {
    mkdirSync(join(homedir(), '.mipham'), { recursive: true })
    writeFileSync(TRUST_STORE_PATH, 'not-valid-json{{{', 'utf-8')

    const fresh = new WorkspaceTrust()
    expect(fresh.listTrusted()).toEqual([])
  })

  it('getStorePath returns the correct path', () => {
    expect(trust.getStorePath()).toBe(TRUST_STORE_PATH)
  })
})

describe('getWorkspaceTrust singleton', () => {
  beforeEach(() => {
    try {
      rmSync(TRUST_STORE_PATH, { force: true })
    } catch {}
    resetWorkspaceTrust()
  })

  it('returns the same instance on repeated calls', () => {
    const a = getWorkspaceTrust()
    const b = getWorkspaceTrust()
    expect(a).toBe(b)
  })

  it('resetWorkspaceTrust creates a new instance', () => {
    const a = getWorkspaceTrust()
    resetWorkspaceTrust()
    const b = getWorkspaceTrust()
    expect(a).not.toBe(b)
  })
})

/**
 * The skip has to be *sayable*. A gate that silently does nothing looks exactly
 * like a gate that passed — which is the failure this audit keeps finding, and
 * the reason the non-TTY path no longer answers "untrusted" with silence.
 */
describe('warnProjectHooksSkipped', () => {
  it('names the file it skipped, so the skip is not silent', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      warnProjectHooksSkipped('/tmp/some-workspace')

      const printed = write.mock.calls.map((c) => String(c[0])).join('')
      expect(printed).toContain(join('/tmp/some-workspace', '.mipham', 'settings.json'))
      expect(printed).toContain('hooks')
    } finally {
      write.mockRestore()
    }
  })
})
