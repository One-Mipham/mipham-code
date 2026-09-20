/**
 * anchor 契约守卫 —— 两向派生。
 *
 * 真源在 `eval-harness.ts` 每个契约的**定义处**（内联 `anchor: true`）；
 * `ANCHOR_CONTRACT_IDS` 是**独立声明**。两处独立陈述同一件事 ⇒ 它们可能不一致 ⇒
 * 本守卫才有内容。
 *
 * 只做一向（声明 → 产出）交付的是**一半**：抓得到拼错与删除，抓不到
 * 「新加的安全契约忘了进表」。第二向覆盖的正是这条路径 ——
 * `red-team-zero-gaps` 与 `blast-radius-gate` 当初都是这样加进来的。
 *
 * **`ANCHOR_CONTRACT_IDS` 已无任何生产消费者** —— 运行时角色由契约定义处的 `r.anchor`
 * 在 `runEval()` 末尾派生（`if (r.anchor) r.role = 'anchor'`），闸门读的是派生出的 `role`
 * （`regressedAnchors` 过滤 `role === 'anchor'`）。那个 export 现在**只被本文件读**。
 * 故本守卫的牙齿**全在「声明」这一侧**：它存在的唯一内容是让这行**可审计的声明**
 * 与定义处的标记不漂移；没有它，两者不一致就无人过问（运行时也不会报错）。
 * 看到 `pnpm knip` 把它列成 unused export 时**不要删** —— 那是本守卫唯一被保护的对象，
 * 删掉它本文件连 import 都过不去，于是**两者必然被当成一对删除**，而这一步没有任何
 * 运行时症状。该列出项既非缺陷也不构成门禁（`knip.json` 的 `ignore` 含 `"test/**"`、
 * 脚本带 `--no-exit-code`）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { runEval, ANCHOR_CONTRACT_IDS } from '../../src/core/eval-harness'

/**
 * 判据本体。返回不一致的描述（排序后），一致时返回空数组。
 *
 * 抽成函数是为了让负控能**跑同一条判据** —— 否则「负控」会变成另写一个
 * 更容易失败的比较，证明不了本判据能失败。
 */
function anchorSetMismatch(declared: string[], inlined: string[]): string[] {
  const d = new Set(declared)
  const i = new Set(inlined)
  return [
    ...[...d].filter((x) => !i.has(x)).map((x) => `声明未内联: ${x}`),
    ...[...i].filter((x) => !d.has(x)).map((x) => `内联未声明: ${x}`),
  ].sort()
}

function inlinedAnchorIds(): string[] {
  return runEval()
    .results.filter((r) => r.anchor)
    .map((r) => r.id)
}

/**
 * 取出 `inlinedAnchorIds` 的**函数体源码** —— 这是**守卫的守卫**。
 *
 * 它不测真值（真值由 `runEval()` 给），它测的是**抽取这一步还在读 `r.anchor`**。
 * 理由是上面这四条集合比较**没有一条能测出「抽取被改写成自洽形式」**：
 * 把函数体换成 `return [...ANCHOR_CONTRACT_IDS]` 后，声明侧与派生侧**按构造相等**，
 * 于是第 1、3、4 条一起变绿，连「真的删掉一处 `anchor: true`」也照样全绿。
 * 到那一步，本文件里唯一还记得那次改写的东西就是**它自己的源码**。
 *
 * **只能取函数体、不能全文匹配**：判据的正则字面量就写在本文件里，全文匹配会让守卫
 * 匹配到自己那行注释（自我满足的另一种形态）。故先按锚点切出函数体，再在切片上匹配。
 */
function extractionBody(): string {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf-8')
  const start = src.indexOf('function inlinedAnchorIds')
  // fail-closed：切片锚点找不到就红，不要静默回退成「匹配空串」。
  expect(start, '本文件里找不到 `function inlinedAnchorIds` —— 切片锚点失效').toBeGreaterThan(-1)
  const end = src.indexOf('\n}', start)
  expect(end, '找不到 `inlinedAnchorIds` 函数体结尾').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('anchor 契约接线', () => {
  it('声明集与内联集两向相等', () => {
    expect(anchorSetMismatch([...ANCHOR_CONTRACT_IDS], inlinedAnchorIds())).toEqual([])
  })

  it('每个声明的 id 都真的出现在 runEval 的产出里', () => {
    // **不是第二条独立的网**：现行抽取下 `inlinedAnchorIds() ⊆ produced`，
    // 故第 1 条通过即蕴含本条通过（这两条不会各自独立地红）。
    // 保留它是因为别处给不了的两点：① 它是唯一与 `runEval()` 有**独立接触**的断言
    // （第 1 条只看两个字符串集合，真源在别处）；② 它唯一表达**幻影 id** ——
    // 声明里有、产出里**根本没有这个 id**，与「有 id 但没标 anchor」是两种病。
    const produced = new Set(runEval().results.map((r) => r.id))
    expect([...ANCHOR_CONTRACT_IDS].filter((id) => !produced.has(id))).toEqual([])
  })

  it('空转守卫：集合被清空或抽取失效后不得静默全绿', () => {
    // 取 ≥15 而非 ==17：让后续新增 anchor 不必回来改这个数。
    // 本条只挡抽取「返回空 / 变少」（r.anchor 恒 undefined 那类 —— 那会让第 1 条报 17 条
    // `声明未内联`，此处兜底）。
    expect(inlinedAnchorIds().length).toBeGreaterThanOrEqual(15)
    // 上面那条挡不住**抽取被改写成自洽形式**（`return [...ANCHOR_CONTRACT_IDS]`）：
    // 那种形态下集合比较全部通过、数量也够，本文件里只有源码还留着痕迹。
    // 注意这是**对抽取步骤的守卫，不是对真值的守卫** —— 真值仍由第 1 条两侧比对来判。
    expect(extractionBody()).toMatch(/\.filter\(\(r\) => r\.anchor\)/)
  })

  it('判据能失败（负控）：把一个 id 拼错会被抓出两条', () => {
    // 本条覆盖的是**判据本体**（`anchorSetMismatch`），**不是抽取步骤**：
    // 它把**声明侧**敲错一处再喂给同一条判据，故抽取被改写成自洽形式时它**照样报出
    // 期望的两条**（自洽形态下 `declared` 与 `inlined` 本就相等，typo 与它的差恰好
    // 就是「一缺一多」）。抽取那一步的守卫在上面「空转守卫」条里。
    const declared = [...ANCHOR_CONTRACT_IDS]
    const inlined = inlinedAnchorIds()
    // 正控：真实集合 → 一致
    expect(anchorSetMismatch(declared, inlined)).toEqual([])
    // 负控：把声明里的 'blast-radius-gate' 敲成 'blast-radius-gates'
    //（正是本守卫存在的理由 —— 这张契约仍会跑、仍会 FAIL，但已不再是 anchor）
    const typo = declared.map((x) => (x === 'blast-radius-gate' ? 'blast-radius-gates' : x))
    expect(anchorSetMismatch(typo, inlined)).toEqual([
      '内联未声明: blast-radius-gate',
      '声明未内联: blast-radius-gates',
    ])
  })
})
