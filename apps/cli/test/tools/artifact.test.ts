import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ArtifactServer } from '../../src/artifacts/server'
import { artifactsRoot } from '../../src/artifacts/paths'
import { artifactTool } from '../../src/tools/artifact/artifact'
import { ARTIFACT_PORT } from '../../src/shared/constants'

// `/artifact open` 真的会 spawn 一个浏览器进程 —— 测试里把它截住，只读实参。
const spawnMock = vi.hoisted(() =>
  vi.fn((_cmd: string, _args: string[], _opts?: unknown) => ({ unref: () => {} })),
)
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}))

// ============================================================
// Artifact 的「坐标」只能有一个来源。
//
// 工具写文件、服务端起根、`/artifact list|open` 找文件，四处各算一次路径就是当初
// 那个 100% 404 的来源：工具写 <cwd>/artifacts、服务端以 <cwd>/.mipham/artifacts
// 为根，两边永不相遇；命令那边还把会话 id 与端口写死成 `session-1`/9876，而工具
// 用的是真 id 与实际端口（服务端遇占用会自增）。
//
// 所以断言一律钉在**用户实际会做的动作**上：拿工具印出来的 URL 去 fetch、看命令
// 打开的是不是同一个 URL。换成字符串常量断言，改个名字就绕过去了。
// ============================================================

describe('Artifact 坐标一致', () => {
  let tmpDir: string | undefined
  let server: ArtifactServer | undefined
  let prevCwd = ''

  afterEach(() => {
    server?.stop()
    server = undefined
    if (prevCwd) {
      process.chdir(prevCwd)
      prevCwd = ''
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = undefined
    }
  })

  /** 起一个真服务端 + 用真工具写一份 artifact，返回工具回报的 URL 与端口。 */
  async function writeArtifact(
    sessionId = 'test-session',
  ): Promise<{ url: string; port: number; content: string; sessionId: string }> {
    tmpDir = mkdtempSync(join(tmpdir(), 'mipham-artifact-'))
    // 命令侧是从 process.cwd() 推导坐标的（会话的真实工作目录），故这里也要切过去。
    prevCwd = process.cwd()
    process.chdir(tmpDir)

    server = new ArtifactServer(artifactsRoot(tmpDir), ARTIFACT_PORT)
    const port = await server.start()

    const content = '<h1>probe-artifact</h1>'
    const result = await artifactTool.execute(
      { name: 'probe-artifact', type: 'html', content },
      { cwd: tmpDir, sessionId, provider: 'test', model: 'test-model', artifactServer: server },
    )
    expect(result.success).toBe(true)

    // 从工具**印给用户的那一行**里取 URL —— 自测里另算一次路径就白测了。
    const url = /URL:\s+(\S+)/.exec(result.content)?.[1]
    expect(url).toBeTruthy()
    return { url: url!, port, content, sessionId }
  }

  async function artifactCmd() {
    const { getCommand } = await import('../../src/ui/commands')
    const handler = getCommand('/artifact')
    expect(handler).toBeTruthy()
    return handler!
  }

  it('工具回报的 URL 真能取到内容（原本必然 404）', async () => {
    const { url, content } = await writeArtifact()

    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(content)
  })

  it('Gallery（服务端读 manifest 渲染）也看得见同一份 artifact', async () => {
    const { port } = await writeArtifact()

    const gallery = await fetch(`http://localhost:${port}/`)
    expect(gallery.status).toBe(200)
    expect(await gallery.text()).toContain('probe-artifact')
  })

  it('/artifact list 列出本会话的 artifact（会话 id 取自真实上下文）', async () => {
    const { sessionId } = await writeArtifact('sess-real')
    const handler = await artifactCmd()

    const out = await handler({ sessionId } as never, ['list'])
    expect(out.content).toContain('probe-artifact')
  })

  it('/artifact open 打开的就是工具回报的那个 URL', async () => {
    const { url, sessionId } = await writeArtifact()
    const handler = await artifactCmd()
    spawnMock.mockClear()

    const out = await handler({ sessionId } as never, ['open', 'probe-artifact'])

    expect(out.content).toContain(url)
    const [, args] = spawnMock.mock.calls[0]! as [string, string[]]
    expect(args).toContain(url)
  })

  it('/artifact open 对不存在的名字给提示，而不是打开一个不存在的地址', async () => {
    await writeArtifact()
    const handler = await artifactCmd()
    spawnMock.mockClear()

    const out = await handler({ sessionId: 'sess-real' } as never, ['open', 'no-such-artifact'])

    expect(out.content).toContain('No artifact named')
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
