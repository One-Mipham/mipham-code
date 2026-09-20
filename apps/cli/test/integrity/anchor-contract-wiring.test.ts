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
 *
 * 本文件对 `eval-harness` 上了**文件级 mock，但默认委派回真实实现**（见下方 `vi.mock`）
 * —— 第 1/2/4 条比的仍是真产出；只有第 3 条在自己的 `it` 内临时换上合成产出。
 */
import { describe, it, expect, vi } from 'vitest'

import { runEval, ANCHOR_CONTRACT_IDS } from '../../src/core/eval-harness'

vi.mock('../../src/core/eval-harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/eval-harness')>()
  // **默认必须委派回真实实现** —— 这不是可选项：若这里返回自制报告，第 1/2/4 条会被
  // 静默架空（比没有守卫更坏）。第 3 条只用 `mockReturnValueOnce` 临时换一次。
  return { ...actual, runEval: vi.fn(actual.runEval) }
})

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

  it('空转守卫：抽取对 runEval 输出迟钝（清空 / 同义反复 / 诱饵）时不得静默全绿', () => {
    // 取 ≥15 而非 ==17：让后续新增 anchor 不必回来改这个数。
    // 这一条只挡抽取「返回空 / 变少」（`r.anchor` 恒 undefined 那类 —— 那会让第 1 条报
    // 17 条 `声明未内联`，此处兜底）。
    expect(inlinedAnchorIds().length).toBeGreaterThanOrEqual(15)

    // ── 行为探针：抽取必须**对 `runEval` 的输出有反应** ──
    //
    // 为什么不能只比集合：抽取被改写成**同义反复**（如 `return [...ANCHOR_CONTRACT_IDS]`）时，
    // 声明侧与派生侧**按构造相等** ⇒ 第 1/2/4 条一起变绿，连真的删掉一处 `anchor: true`
    // 也照样全绿。集合比较**不可能**测出这一点（那一场景下真值完好、两侧本就相等），
    // 此时唯一还可分辨的性质就是**对输入的敏感性** —— 故喂一个合成产出、看抽取是否跟着变。
    //
    // 合成产出刻意与声明集**不同**：去掉一条**声明里有**的 anchor 契约、加一条**声明里没有**
    // 的合成契约 ⇒ 「抽取反映的是产出」与「抽取不是声明集的副本」各有一条判据。
    // 这比读本文件源码文本强在两处：① 诱饵注释绕不过去（源码形态可绕、行为不能）；
    // ② 语义等价改写（`r.anchor === true`、抽成另一个 helper）不再误报。
    //
    // 探针的**边界**（如实记）：它证明的是「抽取对产出敏感」，一次合成产出**不等于**证明
    // 抽取就是 `filter(r => r.anchor)` 那一条；对产出敏感但与声明不一致的形态由第 1 条管。
    const probeId = 'zz-probe-anchor-contract'
    const real = runEval()
    vi.mocked(runEval).mockReturnValueOnce({
      ...real,
      results: [
        ...real.results.filter((r) => r.id !== 'rule-timeout'),
        {
          id: probeId,
          description: '合成探针契约（不由真实 harness 产出）',
          passed: true,
          anchor: true,
        },
      ],
    })
    // 桩只生效**一次** ⇒ 这里只读一次，读完自动恢复委派。
    const probed = inlinedAnchorIds()
    expect(probed).toContain(probeId)
    expect(probed).not.toContain('rule-timeout')

    // 桩已过期 ⇒ 必须回到真实委派。这条同时是**「默认委派」的自检**：若 `vi.mock` 工厂
    // 哪天被改成返回自制报告，第 1/2/4 条会被静默架空，而本条会先红。
    expect(inlinedAnchorIds()).toContain('rule-timeout')
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
