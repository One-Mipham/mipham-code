/**
 * `/copy` 无参数时的交互选择器（295-003）。
 *
 * 此前裸 `/copy` 只会「复制最近 1 条」，想拿第 3 条近的回复得**自己数顺序**再敲
 * `/copy 3`，且敲之前看不到任何候选 —— 数错一位就复制错，而复制错**没有反馈**
 * （剪贴板内容不上屏）。这里把它拆成两条路：
 *
 * - 有明确条数（`/copy N`）或只有一条回复 ⇒ 直进剪贴板，行为与从前逐字相同；
 * - 裸 `/copy` 且有多条 ⇒ 交出候选列表，由 UI 层开选择器。
 *
 * 判据一律落在**世界变了什么**（返回的 `copyContent` / `openCopyPicker`、`onSelect`
 * 收到的实参），不落在「面板画成什么样」上。
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import { getCommand } from '../../src/ui/commands'
import { CopyPicker, type CopyPickerItem } from '../../src/ui/copy-picker'

const DOWN = '\x1b[B'
const ENTER = '\r'
const ESC = '\x1b'

/** ink-testing-library 无 act 包装，交还事件循环让 setState / effect 落定。 */
const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type Result = { content: string; copyContent?: string; openCopyPicker?: CopyPickerItem[] }

const mkCtx = (messages: unknown[]) =>
  ({
    engine: { getContext: () => ({ getMessages: () => messages }) },
    config: { providers: [] },
    providerId: 'test',
    modelId: 'test-model',
    version: '0.0.0',
  }) as never

const runCopy = (messages: unknown[], args: string[] = []): Result =>
  getCommand('/copy')!(mkCtx(messages), args) as unknown as Result

const assistant = (text: string) => ({ role: 'assistant', content: text })
const user = (text: string) => ({ role: 'user', content: text })

describe('/copy 的参数判决', () => {
  it('无助手回复 ⇒ 不复制、不开选择器', () => {
    const r = runCopy([user('hi')])
    expect(r.copyContent).toBeUndefined()
    expect(r.openCopyPicker).toBeUndefined()
  })

  it('恰好一条助手回复 ⇒ 直接复制，不开选择器（一条没有可选的余地）', () => {
    const r = runCopy([user('hi'), assistant('only answer')])
    expect(r.copyContent).toBe('only answer')
    expect(r.openCopyPicker).toBeUndefined()
  })

  it('多条助手回复 + 裸 /copy ⇒ 交出候选列表，**不**猜「最近一条」直接复制', () => {
    const r = runCopy([assistant('first'), user('q'), assistant('second')])
    expect(r.copyContent).toBeUndefined()
    expect(r.openCopyPicker).toHaveLength(2)
    // 顺序 = 会话顺序；`text` 是**完整正文**（复制要的是全文，不是预览）。
    expect(r.openCopyPicker!.map((i) => i.text)).toEqual(['first', 'second'])
  })

  it('候选标签按「距最近第几条」编号（#2 = 最早那条），且带首行预览', () => {
    const r = runCopy([assistant('early\nbody'), assistant('late\nbody')])
    const labels = r.openCopyPicker!.map((i) => i.label)
    expect(labels[0]).toContain('#2')
    expect(labels[1]).toContain('#1')
    // 预览只取首行 —— 正文可能有几百行，面板是拿来分辨的、不是拿来读的。
    expect(labels[0]).toContain('early')
    expect(labels[0]).not.toContain('body')
  })

  it('/copy N 仍直进剪贴板、不开选择器（旧写法逐字不变）', () => {
    const r = runCopy([assistant('a'), assistant('b'), assistant('c')], ['2'])
    expect(r.openCopyPicker).toBeUndefined()
    expect(r.copyContent).toBe('b\n\n---\n\nc')
  })

  it('/copy 0 与 /copy 非数字 ⇒ 用法提示，二者都不复制', () => {
    for (const bad of ['0', 'abc']) {
      const r = runCopy([assistant('a'), assistant('b')], [bad])
      expect(r.copyContent).toBeUndefined()
      expect(r.openCopyPicker).toBeUndefined()
      expect(r.content).toContain('/copy')
    }
  })
})

// ═══════════════════════════════════════════════════════════════
// 选择器本体
// ═══════════════════════════════════════════════════════════════

/**
 * 渲染面板只证明「画出来了」；真正会坏的是**按键作用在哪一条上**。
 * 与 `burst-keys.test.ts` 同一病根：一组按键在同一 chunk 里到达时，第二次回调
 * 拿到的还是上一张闭包 —— 用 `idx.value` 做判据的话，「↓ Enter」会选中**按 ↓ 之前**
 * 那一行。故断言落在 `onSelect` 收到的实参上。
 */
describe('/copy 选择器', () => {
  const items: CopyPickerItem[] = [
    { label: '#3 · three', text: 'three' },
    { label: '#2 · two', text: 'two' },
    { label: '#1 · one', text: 'one' },
  ]

  const mk = (over: Partial<Parameters<typeof CopyPicker>[0]> = {}) => {
    const picked: string[] = []
    const closed = vi.fn()
    const r = render(
      React.createElement(CopyPicker, {
        items,
        onSelect: (i: CopyPickerItem) => picked.push(i.text),
        onClose: closed,
        ...over,
      }),
    )
    return { ...r, picked, closed }
  }

  it('候选都渲染出来了（正对照：面板不是空的）', async () => {
    const { lastFrame } = mk()
    await settle()
    const frame = lastFrame() ?? ''
    for (const i of items) expect(frame).toContain(i.label)
  })

  it('默认停在**最近一条**，直接回车就复制它', async () => {
    const { stdin, picked } = mk()
    await settle()
    stdin.write(ENTER)
    await settle()
    expect(picked).toEqual(['one'])
  })

  it('「↓ Enter」一次写入 ⇒ 复制的是**按下 ↓ 之后**那一行（读 read() 不读渲染闭包）', async () => {
    const { stdin, picked } = mk()
    await settle()
    stdin.write(DOWN + ENTER)
    await settle()
    // 默认 index=2（最后一条）；↓ 环绕到 0 ⇒ 选 first。若判据读的是渲染闭包里的
    // 旧 index，这里会收到 'one'。
    expect(picked).toEqual(['three'])
  })

  it('「↑ Enter」从最近一条上移到中间那条', async () => {
    const { stdin, picked } = mk()
    await settle()
    stdin.write('\x1b[A' + ENTER)
    await settle()
    expect(picked).toEqual(['two'])
  })

  it('Esc 关闭，不复制', async () => {
    const { stdin, picked, closed } = mk()
    await settle()
    stdin.write(ESC)
    await settle()
    expect(closed).toHaveBeenCalled()
    expect(picked).toEqual([])
  })
})
