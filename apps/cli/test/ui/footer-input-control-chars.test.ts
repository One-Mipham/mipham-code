/**
 * 页脚（`ui/agent-footer.tsx`）与输入回显（`ui/input.tsx`）—— 通往终端的另外两道口。
 *
 * 为什么必须钉在**帧**上：`sanitizeInlineField` 是纯函数、`test/shared/sanitize.test.ts`
 * 已逐条钉住 —— 但「净化器是对的」推不出「净化器在渲染路径上」。这一点
 * `test/ui/chat-control-chars.test.ts` 已经在 `chat.tsx` 上证明过一次；本文件是同一条
 * 判据用在剩下两处：`display()` 只是**其中**一道口，页脚与输入行各是另一道。
 *
 * 两处内插的字都是不受信的：页脚工具行来自工具调用参数（模型写的命令），
 * agent 名/描述来自子代理定义；输入回显除了键入手打，还能从历史/粘贴带进任意字节
 * （`normalizeInput` 只折叠 `\r\n\t`，ESC 一路穿过）。
 *
 * 判据取自 ink 自己（与 chat 那份同源）：裸 CSI（`\x1b[2J`）它丢掉，但 BEL / CR / DEL
 * 原样穿过，且它**解析** SGR —— `\x1b[8m`（隐藏）被改写成 `\x1b[28m` 照发。所以下面
 * 一律用 SGR 形状的 ESC 当探针：**它在未净化时确实会落进帧**，这条测试才有能力红。
 */
import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { AgentFooter } from '../../src/ui/agent-footer'
import { InputBar } from '../../src/ui/input'
import { formatToolDetail } from '../../src/ui/app'

const cp = (...cps: number[]) => String.fromCodePoint(...cps)
const ESC = cp(0x1b)
const BEL = cp(0x07)
const C1 = cp(0x9b) // 8-bit CSI —— 与 ESC 同一个引导符的另一种编码
const UP = '\u001B[A'
const T0 = 1_700_000_000_000

/** ink-testing-library 无 act 包装，交还事件循环让 setState / effect 落定。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

function footerFrame(props: Parameters<typeof AgentFooter>[0]): string {
  const { lastFrame, unmount } = render(React.createElement(AgentFooter, props))
  const frame = lastFrame() ?? ''
  unmount()
  return frame
}

describe('AgentFooter — 页脚里的模型文本不许把控制字符送进终端', () => {
  it('工具活动行的 detail 里的 ESC / BEL / C1 不落进帧', () => {
    const detail = `echo ${ESC}[8mhidden${BEL}ok${C1}31m done`
    const frame = footerFrame({
      agents: [],
      tick: 0,
      activeTool: { name: 'Bash', detail, startTime: T0 },
    })
    expect(frame).not.toContain(ESC)
    expect(frame).not.toContain(BEL)
    expect(frame).not.toContain(C1)
    // 去掉的是控制符，不是内容。
    expect(frame).toContain('hidden')
    expect(frame).toContain('done')
  })

  it('工具**名**也过同一道口（MCP 服务端给的名字同样是外来字）', () => {
    const frame = footerFrame({
      agents: [],
      tick: 0,
      activeTool: { name: `mcp${ESC}[8m_tool`, detail: 'ls', startTime: T0 },
    })
    expect(frame).not.toContain(ESC)
    expect(frame).toContain('mcp[8m_tool')
  })

  it('agent 状态行的名称与描述走同一道口（同文件、同源）', () => {
    const frame = footerFrame({
      agents: [
        {
          id: 'a1',
          name: `agent${ESC}[8m_one`,
          description: `scan${BEL}ning${C1}`,
          startTime: T0,
          tokensUsed: 0,
          status: 'running',
        },
      ],
      tick: 0,
    })
    expect(frame).not.toContain(ESC)
    expect(frame).not.toContain(BEL)
    expect(frame).not.toContain(C1)
    expect(frame).toContain('scanning')
  })

  // 端到端：真实路径上 detail 由 `formatToolDetail` 产出，而它只把 Bash 那一支递给
  // `sanitizeForDisplay` —— 后者**不剥** ESC。所以这条能过，只可能是页脚自己的口挡住了。
  it('端到端：模型写的命令经 formatToolDetail 到页脚，帧里仍无 ESC', () => {
    const detail = formatToolDetail('Bash', { command: `echo ${ESC}[8mhi` })
    const frame = footerFrame({
      agents: [],
      tick: 0,
      activeTool: { name: 'Bash', detail, startTime: T0 },
    })
    expect(frame).not.toContain(ESC)
    expect(frame).toContain('hi')
  })

  // 正对照。没有它，一个「把页脚整个删掉」的实现同样能过上面全部用例。
  it('正常文本原样可见', () => {
    const frame = footerFrame({
      agents: [
        {
          id: 'a1',
          name: 'scout',
          description: 'reading files',
          startTime: T0,
          tokensUsed: 0,
          status: 'running',
        },
      ],
      tick: 0,
      activeTool: { name: 'Bash', detail: 'ls -la /tmp', startTime: T0 },
    })
    expect(frame).toContain('[Bash ls -la /tmp')
    expect(frame).toContain('scout')
    expect(frame).toContain('reading files')
  })
})

function renderBar(history: string[]) {
  return render(
    React.createElement(InputBar, {
      onSubmit: () => {},
      isLoading: false,
      history,
      onHistoryAppend: () => {},
    }),
  )
}

describe('InputBar 回显 — 从终端粘进来的转义不许把控制字符送进终端', () => {
  it('↑ 调回的历史条目里的 ESC / BEL / C1 不落进帧', async () => {
    const { stdin, lastFrame } = renderBar([`echo ${ESC}[31mhi${BEL}${C1}done`])
    stdin.write(UP)
    await settle()
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain(ESC)
    expect(frame).not.toContain(BEL)
    expect(frame).not.toContain(C1)
    expect(frame).toContain('echo [31mhi')
    expect(frame).toContain('done')
  })

  it('正对照：正常文本原样回显（净化没把内容吃掉）', async () => {
    const { stdin, lastFrame } = renderBar(['git status --short'])
    stdin.write(UP)
    await settle()
    expect(lastFrame()).toContain('git status --short')
  })
})
