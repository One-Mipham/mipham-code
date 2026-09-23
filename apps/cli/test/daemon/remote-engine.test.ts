/**
 * RemoteEngine — 权限档位这一条线上**出网**的那一半。
 *
 * `mipham attach` 的页脚在本地，闸门在 daemon 上。缺口的形状是「页脚变了、daemon 没变」：
 * 按键有反应而世界不变。所以这里的观测点不是「有没有调用 setMode」，而是**WS 上出现
 * 了什么帧、以什么顺序** —— 那是 daemon 唯一读得到的东西。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RemoteEngine } from '../../src/daemon/remote-engine'

const PORT = 45998

/** 假 WebSocket：记下每一帧，并允许测试回灌 daemon 的帧。 */
class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this)
    // 与真实现同形：open 发生在构造**之后**（`ensureConnected` 先 new、后挂 handler，
    // 所以这里必须让出一个微任务，否则 onopen 是在 null 上调用）。
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    })
  }

  send(raw: string): void {
    this.sent.push(raw)
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }

  /** 回灌一帧 daemon → client 的消息。 */
  deliver(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)
  }
  types(): string[] {
    return this.frames().map((f) => f.type as string)
  }
}

/** 等一轮宏任务：清掉连接与发送链上的全部微任务。 */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const makeEngine = () => new RemoteEngine({ sessionId: 'sess-1', port: PORT, token: 'tok' })

/** 起一轮 prompt 并推进到「帧都发出去了」，返回停在等待块上的生成器。 */
async function startPrompt(engine: RemoteEngine, prompt: string) {
  const gen = engine.process(prompt)
  const pending = gen.next()
  await tick()
  return { gen, pending }
}

const done = () => ({ type: 'done', sessionId: 'sess-1', stopReason: 'end_turn' })

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RemoteEngine — 权限档位', () => {
  it('门面是**同一个对象**：每次现造一个闭包 = 按键之间什么都记不住', () => {
    const engine = makeEngine()
    // 旧实现每次 `getPermission()` 都新建闭包，于是这两条都红：读回来的是全新的
    // 'default'，请求本身也随闭包一起丢掉。这就是「页脚在自说自话」的机制。
    expect(engine.getPermission()).toBe(engine.getPermission())
    engine.getPermission().setMode('plan')
    expect(engine.getPermission().getMode()).toBe('plan')
    engine.close()
  })

  it('Shift+Tab 出网：档位真的发给 daemon，不是只改本地页脚', async () => {
    const engine = makeEngine()
    engine.getPermission().setMode('plan')
    await tick()

    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error('连都没连：键按了、世界没变')
    expect(ws.types()).toEqual(['set_mode'])
    expect(ws.frames()[0]).toMatchObject({ type: 'set_mode', sessionId: 'sess-1', mode: 'plan' })
    engine.close()
  })

  it('daemon 的答复是权威：被钳制时页脚退回去，且下一轮钉的是钳后值', async () => {
    const engine = makeEngine()
    const seen: string[] = []
    engine.onPermissionModeChange((mode) => seen.push(mode))

    engine.getPermission().setMode('bypassPermissions')
    // 乐观：转盘必须先动（`cyclePermissionMode` 拿 `getMode()` 的回读当结果）
    expect(engine.getPermission().getMode()).toBe('bypassPermissions')
    await tick()

    FakeWebSocket.instances[0]!.deliver({ type: 'mode', sessionId: 'sess-1', mode: 'auto' })
    expect(engine.getPermission().getMode()).toBe('auto')
    expect(seen).toEqual(['auto'])

    // 每轮都重钉 ⇒ 钉的必须是钳后值。留着原请求会让页脚与闸门每轮撞一次钳制、来回跳。
    const { pending } = await startPrompt(engine, 'hi')
    const frames = FakeWebSocket.instances[0]!.frames()
    expect(frames[frames.length - 2]).toMatchObject({ type: 'set_mode', mode: 'auto' })
    FakeWebSocket.instances[0]!.deliver(done())
    await pending
    engine.close()
  })

  it('prompt 之前必重钉，且排在 prompt **之前**（顺序 = 闸门先动）', async () => {
    const engine = makeEngine()
    engine.getPermission().setMode('plan')
    await tick()

    const { pending } = await startPrompt(engine, 'hi')
    const ws = FakeWebSocket.instances[0]!
    const types = ws.types()
    expect(types[types.length - 1]).toBe('prompt')
    expect(types.slice(0, -1).every((t) => t === 'set_mode')).toBe(true)
    expect(ws.frames()[ws.frames().length - 2]).toMatchObject({ mode: 'plan' })

    ws.deliver(done())
    expect((await pending).value).toEqual({ type: 'stop' })
    engine.close()
  })

  it('没选过档就一帧都不发：旁观者不得覆盖 daemon 的 env 档', async () => {
    const engine = makeEngine()
    const { pending } = await startPrompt(engine, 'hi')
    // 只发 prompt。多发一帧 'default' 就会把运维写进 MIPHAM_DAEMON_PERMISSION 的那一档
    // 挤掉 —— 一个从没表达过意图的客户端在**静默改写**闸门。
    expect(FakeWebSocket.instances[0]!.types()).toEqual(['prompt'])
    FakeWebSocket.instances[0]!.deliver(done())
    await pending
    engine.close()
  })

  it('attach 快照里的档只用于**显示**：照它初始化页脚，但不据此改 daemon', async () => {
    const engine = makeEngine()
    const { pending } = await startPrompt(engine, 'hi')
    const ws = FakeWebSocket.instances[0]!

    ws.deliver({
      type: 'session_state',
      sessionId: 'sess-1',
      messages: [],
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      turnCount: 3,
      mode: 'acceptEdits',
    })
    // 页脚学到了 daemon 的档（而不是猜 default）
    expect(engine.getPermission().getMode()).toBe('acceptEdits')
    // 而它仍然是**非块**消息：不进提示流
    ws.deliver(done())
    expect((await pending).value).toEqual({ type: 'stop' })

    const second = await startPrompt(engine, 'again')
    expect(ws.types().filter((t) => t === 'set_mode')).toHaveLength(0)
    ws.deliver(done())
    await second.pending
    engine.close()
  })

  it('attach 快照不得**撤回**本客户端已发出的请求（它早于那条请求）', async () => {
    // 时序是 daemon 定的：`addClient` 一挂上就 `sendState`，而 `--permission plan` 是在
    // TUI 起来**之前**就记下的请求 —— 即快照描述的是「我们那条 set_mode 还没被处理」时的闸门。
    // 若它覆盖 modeChosen，下一轮重钉会把刚拿到的旧值推回去：用户的 flag 被**静默取消**
    // （不是被钳制）。这条与上一条的区别正是判据本身：快照**没有** mode 字段时没人会错，
    // 只有在它带着一个旧档回来时，两种读法才分道扬镳。
    const engine = makeEngine()
    const seen: string[] = []
    engine.onPermissionModeChange((mode) => seen.push(mode))
    engine.getPermission().setMode('plan')
    await tick()
    const ws = FakeWebSocket.instances[0]!

    ws.deliver({
      type: 'session_state',
      sessionId: 'sess-1',
      messages: [],
      provider: 'p',
      model: 'm',
      turnCount: 0,
      mode: 'default',
    })
    expect(engine.getPermission().getMode()).toBe('plan') // 请求还在
    expect(seen).toEqual([]) // 也不值得显示：它已被在途的请求取代

    // 而 daemon 的**答复**（钳制后的）照样改写请求 —— 那是另一条通道
    ws.deliver({ type: 'mode', sessionId: 'sess-1', mode: 'acceptEdits' })
    expect(engine.getPermission().getMode()).toBe('acceptEdits')
    expect(seen).toEqual(['acceptEdits'])

    // 下一轮重钉的是答复后的值，不是快照里那个旧档
    const { pending } = await startPrompt(engine, 'hi')
    const frames = ws.frames()
    expect(frames[frames.length - 2]).toMatchObject({ type: 'set_mode', mode: 'acceptEdits' })
    ws.deliver(done())
    await pending
    engine.close()
  })

  it('不认识的档位帧一概不采纳（跨进程边界，且两侧版本各自演进）', async () => {
    const engine = makeEngine()
    engine.getPermission().setMode('plan')
    await tick()
    const ws = FakeWebSocket.instances[0]!

    // 老 daemon 的 session_state 不带 mode；坏的/未来的值也一样
    ws.deliver({
      type: 'session_state',
      sessionId: 'sess-1',
      messages: [],
      provider: 'p',
      model: 'm',
      turnCount: 0,
    })
    expect(engine.getPermission().getMode()).toBe('plan')
    ws.deliver({ type: 'mode', sessionId: 'sess-1', mode: 'yolo' })
    expect(engine.getPermission().getMode()).toBe('plan')
    engine.close()
  })
})
