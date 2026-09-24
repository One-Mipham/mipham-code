/**
 * 注入上下文必须**带得出来源**（对标档 280 · `context/inject` 无生产者）。
 *
 * 引擎有四处会往对话里塞模型可见的**上下文**（规则块、compact 前后的 hook 提示、
 * stop hook 交回的话），另有后台 agent 的来件。它们此前一律走 `addMessage`，于是
 * 在日志里与**用户真说过的话**完全同形 —— 事后拿到一份 session log，分不出哪一句
 * 是用户敲的、哪一句是我们塞进去的。`SessionEvent` 里那个 `context/inject`
 * （含 `source`）就是为它们声明的，两个方向（`messageToEvents` 的反向 / `deriveMessages`）
 * 也**早就实现了**，唯独**没有生产者**。
 *
 * 这组测试钉两件事：
 *   1. 注入记成 `context/inject` 并带出来源；
 *   2. 投影**逐字节不变** —— 打开运行时那条「model-visible means logged」断言也不许炸
 *      （它逐条比对 deriveMessages(log) 与真实 messages）。
 * 第 2 条才是要害：只改事件名而投影漂了，就是把一个信息问题换成一个正确性问题。
 */

import { describe, it, expect, afterEach } from 'vitest'

import { ContextManager } from '../../src/core/context'
import { SessionLog, deriveMessages, setAssertModelVisibleDebug } from '../../src/core/session-log'

afterEach(() => {
  // 运行时断言门控是模块级全局 —— 关掉，别渗到别的测试文件的行为里
  setAssertModelVisibleDebug(false)
})

const makeCtx = (): ContextManager =>
  new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 })

describe('注入上下文的日志形态', () => {
  it('记成 context/inject 并带出来源，而不是伪装成用户输入', () => {
    const cm = makeCtx()
    cm.setLog(new SessionLog('inject-provenance'))

    cm.injectContext('rules', 'RULE BLOCK')

    const injected = cm
      .getLog()!
      .events()
      .filter((e) => e.type === 'context/inject')
    expect(injected).toHaveLength(1)
    expect(injected[0]).toMatchObject({
      type: 'context/inject',
      source: 'rules',
      text: 'RULE BLOCK',
    })

    // 反面：不许同时再记一条 user/message（否则投影会多出一条）
    expect(
      cm
        .getLog()!
        .events()
        .some((e) => e.type === 'user/message'),
    ).toBe(false)
  })

  it('投影逐字节不变 —— 打开运行时断言也不炸', () => {
    setAssertModelVisibleDebug(true)
    const cm = makeCtx()
    cm.setLog(new SessionLog('inject-roundtrip'))

    expect(() => cm.injectContext('pre-compact', '[Pre-compact context]: keep going')).not.toThrow()

    expect(cm.getMessages()).toEqual([
      { role: 'user', content: '[Pre-compact context]: keep going' },
    ])
    expect(deriveMessages(cm.getLog()!.events())).toEqual(cm.getMessages())
  })
})
