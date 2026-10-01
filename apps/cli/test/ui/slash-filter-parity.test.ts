import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { CommandPicker } from '../../src/ui/command-picker'
import { InputBar } from '../../src/ui/input'
import { getCommandList } from '../../src/ui/commands'

/**
 * 斜杠命令的两个表面必须用**同一条过滤规则**。
 *
 * 同一个查询在 `CommandPicker`（匹配 name 或 description）与 `InputBar` 的提示行
 * （此前只匹配 name）上给出不同结果 —— 一个只靠**描述**命中的命令，在选择器里出现、
 * 在提示行里消失。修法是让提示行也匹配 description，与选择器一致。
 *
 * 查询词 `workspace` 是刻意挑的：它**不是任何命令名**的子串，只是两条描述的片段
 * （`/add-dir` = "Add workspace directory"，`/trust` = ...），所以「匹配到它」这件事
 * 只可能来自 description 那一半。下面前件用例把这一点钉死 —— 否则两条断言都会因
 * 「这个词压根谁都不匹配」而恒红，红的理由却不是被测的规则。
 */

const QUERY = 'workspace'
/** 只靠 description 命中 `QUERY` 的命令名（由真身 getCommandList 算出，不手抄）。 */
const DESCRIPTION_ONLY_HITS = getCommandList()
  .filter((c) => c.description.toLowerCase().includes(QUERY))
  .map((c) => c.name)

/** ink-testing-library 无 act 包装，交还事件循环让 setState / effect 落定。 */
const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function renderBar(): ReturnType<typeof render> {
  return render(
    React.createElement(InputBar, {
      onSubmit: () => {},
      isLoading: false,
      // 关掉选择器 ⇒ 走 InputBar 自己的 slash-hint 行（被修的那一个表面）。
      showCommandPicker: false,
      history: [],
      onHistoryAppend: () => {},
      recentMessages: [],
    }),
  )
}

describe('斜杠过滤规则：选择器与提示行一致（name OR description）', () => {
  it('前件：`workspace` 不是任何命令名的一部分，只出现在描述里', () => {
    const nameHits = getCommandList().filter((c) => c.name.toLowerCase().includes(QUERY))
    expect(
      nameHits,
      '夹具失效：这个词命中了命令名，下面的断言就不再只测 description 那一半',
    ).toEqual([])
    expect(DESCRIPTION_ONLY_HITS.length).toBeGreaterThan(0) // 至少有一个只靠描述命中的命令
  })

  it('选择器：只靠描述命中的命令会出现（参考语义）', () => {
    const { lastFrame } = render(
      React.createElement(CommandPicker, {
        initialFilter: `/${QUERY}`,
        onSelect: vi.fn(),
        onClose: vi.fn(),
      }),
    )
    const frame = lastFrame() ?? ''
    for (const name of DESCRIPTION_ONLY_HITS) expect(frame).toContain(name)
  })

  it('提示行：同一个查询给出**同一批**命令（修复前恒为空 —— 只匹配 name）', async () => {
    const r = renderBar()
    r.stdin.write(`/${QUERY}`)
    await settle()
    const frame = r.lastFrame() ?? ''
    for (const name of DESCRIPTION_ONLY_HITS) {
      expect(frame, `提示行漏掉了只靠描述命中的 ${name} —— 与选择器语义不一致`).toContain(name)
    }
  })
})
