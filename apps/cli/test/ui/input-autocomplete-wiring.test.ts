import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { InputBar } from '../../src/ui/input'
import type { Llm } from '../../src/providers/llm'
import type { ChatRequest } from '../../src/providers/registry'
import type { StreamChunk } from '../../src/shared'

/**
 * ghost-text 自动补全的**接线层**测试（ROADMAP D8 缺口②）。
 *
 * 与 D7 同一层：`extractCompletion` / `shouldAutocomplete` / `buildAutocompleteRequest`
 * 这些纯函数在 `test/core/autocomplete.test.ts` 里已经逐条钉住，`requestSuggestion`
 * 本身也覆盖得不差 —— 但**一条都没碰过 `InputBar`**。「纯函数绿」推不出「Tab 真能把
 * 建议并进正文」：定时器归谁管、reqId 由谁 bump、Tab 有没有被内层输入组件吃掉，
 * 纯函数一无所知。
 *
 * 观测点**刻意选在 `onSubmit`**而不是 `lastFrame()`：建议渲染在与正文同一个 row Box 里
 * （`input.tsx:576`），屏幕上 `> hello world` 这一串**既可能**是「正文已含建议」**也可能**
 * 是「正文 + 幽灵」，字符串断言分不出这两件事。提交出去的值分得出。
 *
 * 每格都配正对照：没有「不按 Tab 时建议确实在屏幕上、且没进正文」那一格，核心格全绿
 * 可能只是因为假 Llm 压根没被调用过。
 */

const TAB = '\t'
const ENTER = '\r'

/** 大于防抖窗口的等待；防抖窗口本身取 200ms 以免被机器卡顿误判成「已触发」。 */
const DEBOUNCE = 200
/** ink-testing-library 无 act 包装，交还事件循环让 setState / effect / 定时器落定。 */
const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 脚本化假 Llm：逐次记录请求，答复可以是字符串或一个（可挂起的）异步函数。 */
class ScriptedLlm implements Llm {
  readonly requests: ChatRequest[] = []
  constructor(private readonly replies: Array<string | (() => string | Promise<string>)> = []) {}

  async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    const index = this.requests.push(req) - 1
    const spec = this.replies[index] ?? this.replies[this.replies.length - 1] ?? 'X'
    const text = typeof spec === 'function' ? await spec() : spec
    yield { type: 'text', content: text }
  }
}

function renderBar(props: { llm?: Llm; submitted?: string[] } = {}): ReturnType<typeof render> {
  const submitted = props.submitted ?? []
  return render(
    React.createElement(InputBar, {
      onSubmit: (v: string) => submitted.push(v),
      isLoading: false,
      history: [],
      onHistoryAppend: () => {},
      llm: props.llm,
      recentMessages: [],
      autocompleteDebounceMs: DEBOUNCE,
    }),
  )
}

describe('ghost-text —— Tab 接受（接线层）', () => {
  it('正对照：建议确实上屏，但不按 Tab 就不进正文', async () => {
    const llm = new ScriptedLlm([' world'])
    const submitted: string[] = []
    const { stdin, lastFrame } = renderBar({ llm, submitted })

    stdin.write('hello')
    await settle(DEBOUNCE * 2)

    expect(llm.requests, '正对照的前提：假 Llm 真的被调用了').toHaveLength(1)
    expect(lastFrame() ?? '', '正对照的前提：建议真的上屏了').toContain('world')

    stdin.write(ENTER)
    await settle()
    expect(submitted, '没按 Tab ⇒ 建议是幽灵，不该并进正文').toEqual(['hello'])
  })

  it('**核心**：Tab 把建议并进正文', async () => {
    const llm = new ScriptedLlm([' world'])
    const submitted: string[] = []
    const { stdin, lastFrame } = renderBar({ llm, submitted })

    stdin.write('hello')
    await settle(DEBOUNCE * 2)
    expect(lastFrame() ?? '').toContain('world')

    stdin.write(TAB)
    await settle()
    stdin.write(ENTER)
    await settle()

    // 断言里没有空格：假 Llm 回的 `' world'` 被 `extractCompletion` 的 `.trim()` 削掉了
    // 首空格，屏幕上的幽灵也是紧贴着渲染的（同在 `input.tsx:576` 那个 row Box）——
    // **所见即所提交**。续写丢掉词间隔是纯函数层的既有行为（`test/core/autocomplete.test.ts`
    // 已按此钉住），本测试只钉接线，不在这里改它。
    expect(submitted, 'Tab 没有把建议并进正文').toEqual(['helloworld'])
  })
})

describe('ghost-text —— 防抖与失效（接线层）', () => {
  it('连打两次只发一次请求，且发的是最后一次的文本', async () => {
    const llm = new ScriptedLlm(['X'])
    const { stdin } = renderBar({ llm })

    stdin.write('hel')
    await settle(DEBOUNCE / 4)
    stdin.write('l') // 前一个定时器必须被清掉
    await settle(DEBOUNCE * 2)

    expect(llm.requests, '防抖窗口内又敲了一下 ⇒ 前一次不该发出去').toHaveLength(1)
    const last = llm.requests[0]?.messages.at(-1)
    expect(last?.content, '发出去的应是最后一次的文本').toBe('hell')
  })

  it('陈旧的补全结果不许上屏（reqId 门）', async () => {
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const llm = new ScriptedLlm([
      async () => {
        await gate
        return 'FIRST'
      },
      () => 'SECOND',
    ])
    const { stdin, lastFrame } = renderBar({ llm })

    stdin.write('a')
    await settle(DEBOUNCE * 2) // 第一次请求在途（挂在 gate 上）
    stdin.write('b') // 使 reqId 失效，并重排第二次
    await settle(DEBOUNCE * 2)
    expect(lastFrame() ?? '', '前提：新请求的结果该上屏').toContain('SECOND')

    releaseFirst()
    await settle(DEBOUNCE)
    expect(lastFrame() ?? '', '旧请求的补全上屏了 —— reqId 门失效').not.toContain('FIRST')
  })

  it('（对照）不打断时，同一个慢补全会上屏', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const llm = new ScriptedLlm([
      async () => {
        await gate
        return 'FIRST'
      },
    ])
    const { stdin, lastFrame } = renderBar({ llm })

    stdin.write('a')
    await settle(DEBOUNCE * 2)
    expect(lastFrame() ?? '', '前提：此刻还没有结果').not.toContain('FIRST')

    release()
    await settle(DEBOUNCE)
    expect(lastFrame() ?? '', '慢补全本身是能上屏的（上面那条的 not 才有意义）').toContain('FIRST')
  })
})
