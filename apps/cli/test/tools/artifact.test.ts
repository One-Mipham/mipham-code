import { describe, it, expect, afterEach, vi, type MockInstance } from 'vitest'
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
  let cwdSpy: MockInstance | undefined

  afterEach(() => {
    server?.stop()
    server = undefined
    cwdSpy?.mockRestore()
    cwdSpy = undefined
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
    // 命令侧是从 process.cwd() 推导坐标的（会话的真实工作目录），故这里也要让它读到 tmpDir。
    //
    // 不用 `process.chdir()`：那是进程级全局突变，而 Stryker 的 vitest-runner 把测试跑在
    // worker 线程里（`pool: 'threads'` 在它源码里写死、无覆盖入口），线程里 chdir 直接抛
    // "process.chdir() is not supported in workers" —— 后果不是这一个文件红，而是整个
    // 变异测试的干跑失败。spy 只改 `process.cwd()` 的返回值，两种跑池下行为一致
    // （同 test/commands/init-providers.test.ts 的既定做法）。
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)

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

  // ============================================================
  // 按名字订阅（GET /:name/sse）。
  //
  // 这条路由原先接的是另一套版本机制（<root>/<name>/current.html），而写那个文件的
  // 方法全仓库零调用点 ⇒ 流永远推不出一个字节，却始终回 200 挂着。它现在读的是工具
  // 真正写下的那份文件；下面两条把它钉在「有内容」与「没有就 404」两端。
  // ============================================================

  /** 取到第一段包含 `needle` 的 SSE 数据（单次 write 未必落在一个 chunk 里）。 */
  async function firstSseMatch(url: string, needle: string): Promise<string> {
    const ctrl = new AbortController()
    const res = await fetch(url, { signal: ctrl.signal })
    expect(res.status).toBe(200)

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let seen = ''
    try {
      for (let i = 0; i < 5 && !seen.includes(needle); i++) {
        const { value, done } = await reader.read()
        if (done) break
        seen += decoder.decode(value)
      }
    } finally {
      ctrl.abort()
    }
    return seen
  }

  it('按名字订阅推的是工具写下的那份内容', async () => {
    const { port, content } = await writeArtifact()

    const seen = await firstSseMatch(
      `http://localhost:${port}/probe-artifact/sse`,
      'probe-artifact',
    )

    expect(seen).toContain(JSON.stringify(content))
  })

  it('按名字订阅一个不存在的 artifact → 404，而不是一条挂着的空流', async () => {
    const { port } = await writeArtifact()

    const res = await fetch(`http://localhost:${port}/no-such-artifact/sse`)

    expect(res.status).toBe(404)
    expect(await res.text()).toContain('No artifact named')
  })

  // ============================================================
  // stop() 要真的停。
  //
  // `server.close()` 只停止**接收新连接**：已经建立的连接（浏览器的 keep-alive、
  // 一条 SSE 流）会继续被服务。测试里这会以「换了个测试仍在跟上一个 server 说话」
  // 的形态出现 —— 本文件每个用例都复用 ARTIFACT_PORT，而上一个 server 的目录已被
  // afterEach 删掉，于是请求落到一个 manifest 为空的服务端上，随机 404。
  // ============================================================

  it('stop() 断开已建立的连接，而不是只停止接收新连接', async () => {
    const { port } = await writeArtifact()

    // 上游症状是「换了个测试仍在跟上一个 server 说话」：`server.close()` 只停止**接收**
    // 新连接，已建立的那条继续被服务。
    //
    // 本格必须拿**进行中的**响应来测，两条反例（本轮逐一实测过）都不行：
    //   · 裸 socket —— TCP 握手在 listen backlog 里就能完成，客户端 'connect' 早于
    //     服务端 'connection'（实测此刻 `sockets=0`，服务端从未见过这条连接）。此时
    //     `stop()` 关掉的只是 listening handle，backlog 里那条被内核 RST 掉，客户端
    //     照样收到 'close' ⇒ 绿得毫无意义；
    //   · 发过一个请求后闲置的 keep-alive —— `close()` 自己就会关掉它。
    // `/:name/sse` 是真正的 active 响应，而且 `handleNameSse` 不像 `/events` 那样登记
    // 进 `sseClients`，故 `stop()` 里那句 `res.end()` 也够不着它 —— 能切断它的只有
    // `socket.destroy()`。
    const res = await fetch(`http://localhost:${port}/probe-artifact/sse`)
    expect(res.status).toBe(200)

    const reader = res.body!.getReader()
    // 前置：流真的推来了第一段内容（否则下面「断了」可能只是因为压根没接上）
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(new TextDecoder().decode(first.value)).toContain('probe-artifact')

    server!.stop()

    // 该流每条内容只推一次（`handleNameSse` 仅在与上次不同时才写），所以此刻要么
    // 被切断（done / 读失败），要么永远挂着 —— 后者即「仍在被服务」。
    const outcome = await Promise.race([
      reader.read().then(
        (r) => (r.done ? 'ended' : 'still-streaming'),
        () => 'errored',
      ),
      new Promise<string>((r) => setTimeout(() => r('still-open'), 2000)),
    ])
    expect(outcome).not.toBe('still-open')
  })
})
