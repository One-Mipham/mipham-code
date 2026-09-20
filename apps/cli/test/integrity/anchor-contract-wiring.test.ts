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
 * 那句「默认委派」在**产出一侧**由第 3 条末尾的**同一性自检**（`vi.importActual` + 对
 * `runEval()` 的产出做**显式投影比较** —— 逐条比 `id` / `passed` / `anchor === true` / `role`
 * 四个字段，见下方 `project`）背书 —— 没有它，「工厂改成返回自制报告」这一形态能让本文件 4 绿
 * （连真删一处 `anchor: true` 也无信号）。**它比的是投影里的四个字段，不是整个对象**：
 * 投影读 `anchor` 走的是**属性访问**，与抽取器同一条读取路径 ⇒ `toEqual`（比可枚举自有属性）
 * 看不见的**非枚举自有属性**与**读时 getter** 在这里现形（R5 实测：`heal_nonenum` /
 * `heal_getter` 两种产出一侧伪装在旧深比下 4 绿、在投影下红）。**它闭不掉有状态载体** ——
 * 只在**被比较的那一次调用**上说真话的工厂仍 4 绿；那是**比较型判据**的结构边界，理由见
 * 文件末尾「已知残留」第三条轴。**它钉不到声明侧**：工厂只改写 `ANCHOR_CONTRACT_IDS`
 * （产出仍真委派）时本文件同样 4 绿（R4 实测），抓那条的是同一条 `it` 里的 clos1。
 *
 * **已知残留（如实记）**：诱饵没有被消灭，它只是**换了载体** —— 从 helper 体内的注释换成了
 * 谓词里的一个析取项（`r.anchor || r.id === '<真 anchor id>'`，或以别的字段为键的
 * `r.anchor || !r.passed`）。第 3 条的**逐契约摘标记**（每个声明 id 各摘一次）与**非 anchor
 * 的 FAIL 诱饵条目**正是为这两个载体设的判据；但枚举不等于证明 —— 「没被枚举中的那种不忠实
 * 谓词」仍然只有第 1 条与行为探针在管，而它们对「在真产出上与声明一致却不忠实」的谓词是盲的。
 *
 * **第二条残留轴（R5 补记）：产出对象在「被读」时伪装。** 上一条讲的是**谓词**不忠实；本条讲
 * **产出本身**在抽取器读它时撒谎 —— 工厂把 `anchor` 以**非枚举自有属性**或**读时 getter** 补回：
 * 抽取器读得到（属性访问），而旧判据 `expect(runEval()).toEqual(original.runEval())` 看不见
 * （`toEqual` 比的是**可枚举自有属性**）。
 * **这一轴已由第 3 条末尾的显式投影比较闭合 —— 但「红在哪条判据上」必须分开说**（R5 复评实测）：
 * 新版上 `heal_nonenum` / `heal_getter`（+ 真删 `merge-convergence-gate` 的 `anchor: true,`）
 * **红在 clos3** —— 而 clos3 看的是 `role`，与 `enumerable` 一个字不相干 ⇒ 这一对**只证明存在性**
 *（修前绿 / 修后红），**不构成「投影闭了这一轴」的证据**。该轴的隔离证据是另两格：
 * ① 出货件侧（旧深比）：`heal_enum` 红 / `heal_nonenum` 绿 ⇒ `enumerable` 是唯一差别；
 * ② 新版侧（clos3 中和后）：`heal_nonenum` 红在**投影** ⇒ 投影确实承重。
 * ⚠️ 新版上 `heal_enum` 与 `heal_nonenum` 是**同因同断言**（都红在 clos3），并排红说明不了
 * `enumerable` 有任何作用 —— 别把「两格都红」读成「隔离出了唯一差别」。
 *
 * **第三条残留轴（R5 补记，本文件**闭不掉**）：有状态载体。** 工厂只在**被比较的那一次调用**上
 * 返回真产出，其余调用照旧伪装：
 *
 * ```ts
 * let n = 0
 * const heal = () => {
 *   n++
 *   const t = actual.runEval()
 *   if (n === 8) return t // 被比较的那一次：说真话
 *   // 其余调用：伪装 —— 必须**同时**补 `anchor` **与** `role`
 *   return 照 heal_enum 的写法补回 anchor，并把 role 一并补成 'anchor'
 * }
 * ```
 *
 * **`role` 那一半是承重的，不是修饰**：角色派生跑在 `runEval()` **内部**、且在 `anchor` 被删
 * **之后**（`eval-harness.ts` 末尾：`for (const r of results) if (r.anchor) r.role = 'anchor'`）；
 * 载体是在拿到产出**之后**才把 `anchor` 贴回去的，故 `role` 仍是 `undefined` ⇒ **clos3 无条件红**
 * （它过滤的正是 `ANCHOR_CONTRACT_IDS.has(r.id) && r.role !== 'anchor'`），与 K 取几无关。
 * ⇒ 只补 `anchor`（= 照 `heal_enum` 原样：它的写法就是 `{ ...x, anchor: true }`，**不含** `role`）
 * 时 **K = 1..12 全红、没有任何 K 能 `EXIT 0`**；补 `anchor` + `role` 才有唯一绿 —— 两个读数
 * 都是 R5 复评实测。**照本配方复现时别少补 `role`**：少了它，读者会把「全 K 红」读成
 * 「这个残余已经不存在」，进而**删掉一条正确的登记**（这正是本批招牌缺陷类最坏的形态）。
 *
 * R5 实测：**本文件**上是 `n === 8` 才 `EXIT 0 / 4 passed`（真删一处 `anchor: true` 照样 4 绿；
 * `n === 7` 与 `n === 24` 都是 `EXIT 1`）；同一载体在**修前的出货件**上要 `n === 7`
 * （那件上 `n === 8` 是 `EXIT 1`）⇒ **序数是文件的属性，不是一个常数**。
 * 序数不是推出来的：把 `n` 打到磁盘（`TRUTH-AT 8`）再读栈帧落点，与本文件的投影比较同一处。
 * 机制上，受 mock 的 `runEval()` 在本文件被调用 **9** 次（`trace` 载体把每次调用写盘实测；
 * 出货件按同一算法为 8 次，未单独打点）—— `mockReturnValueOnce`
 * **不调用**实现、直接返回队首，故那 18 次（1 次行为探针 + 17 次逐契约循环）不计入；
 * 本文件比出货件多的一次对应 clos3（它在投影**之前**多读一次 `runEval()`）。
 *
 * **为什么闭不掉（这是判据的边界，不是「还没想到」）**：比较型闭包的前提是
 * 「**被比较的那一次调用必然是伪装的那次**」。有状态载体可以**挑出那一次调用**说真话，
 * 于是**任何**「拿产出与真值比」的判据 —— 旧深比、新的显式投影、逐契约摘标记、clos2 —— 都是
 * 同一型，都能被它绕过。闭它要换一条**不再读「被比较的那一次调用」返回值**的轴。
 * R5 实测过一条候选：`expect(vi.mocked(runEval).getMockImplementation()).toBe(original.runEval)`
 * —— 它在健康树上绿（4 passed）、在 `heal_stateful_role:8` + 真删 `:405` 上红
 * （`expected [Function heal] to be [Function runEval]`）⇒ **该轴存在**；但那是「工厂有没有
 * 换过 mock 的实现」这一接线，不是本文件所守的「**声明 ↔ 定义处标记**」一致，且**它依赖
 * `importOriginal` 与 `vi.importActual` 拿到同一个模块实例**（今天成立，不是契约）。
 * 本轮按控制器裁定**只登记、不实施**。本条**只**主张「比较型判据闭不掉它」，**不**主张「无人能闭」。
 */
import { describe, it, expect, vi } from 'vitest'

import { runEval, ANCHOR_CONTRACT_IDS } from '../../src/core/eval-harness'

vi.mock('../../src/core/eval-harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/eval-harness')>()
  // **默认必须委派回真实实现** —— 这不是可选项：若这里返回自制报告，第 1/2/4 条会被
  // 静默架空（比没有守卫更坏）。第 3 条只用 `mockReturnValueOnce` 临时换一次。
  // 而且「返回自制报告」有两种：`results: []` 那类粗暴掏空会被第 3 条立刻报红，但**由
  // `ANCHOR_CONTRACT_IDS` 构造的**自制报告与声明自洽、与真产出同形 ⇒ 整个文件 4 绿
  // （R3 实测）。抓后者的是第 3 条末尾的同一性自检，不是本文件里的任何集合比较。
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
    // 保留它是因为别处给不了的两点：① 它与 `runEval()` 有**直接接触**（不经抽取器、也不看
    // 两个字符串集合）—— 但**不是唯一**读它的断言：第 3 条末尾的投影比较与第 4 条的 `inlined`
    // 都读；它独有的是**读法**（比 id 全集，不比 anchor 标记）；② 它表达**幻影 id** ——
    // 声明里有、产出里**根本没有这个 id**，与「有 id 但没标 anchor」是两种病（这一点只有
    // 它表达）。
    const produced = new Set(runEval().results.map((r) => r.id))
    expect([...ANCHOR_CONTRACT_IDS].filter((id) => !produced.has(id))).toEqual([])
  })

  it('空转守卫：抽取脱钩（清空 / 同义反复）、多认条目（谓词析取项）、或委派被架空时不得静默全绿', async () => {
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
    // 这比读本文件源码文本强在两处：① 诱饵**注释**绕不过去（源码形态可绕、行为不能）——
    // 但诱饵没有消失，它只是换了载体：谓词里掺一个析取项同样是诱饵（见下面的逐契约摘标记）；
    // ② 语义等价改写（`r.anchor === true`、抽成另一个 helper）不再误报。
    //
    // 探针的**边界**（如实记）：它证明的是「抽取对产出敏感」，一次合成产出**不等于**证明
    // 抽取就是 `filter(r => r.anchor)` 那一条。① 对产出敏感但与声明**不一致**的形态由第 1 条
    // 管（实测：`r.anchor || r.passed` 会在第 1 条报 `内联未声明`）；② 对产出敏感、在真产出上
    // 与声明**一致**、却不忠实的形态（`r.anchor || r.id === '<真 anchor id>'`）第 1 条看不见
    // —— 由下面的逐契约摘标记管。
    const probeId = 'zz-probe-anchor-contract'
    const real = runEval()
    const baseline = real.results.filter((r) => r.anchor).map((r) => r.id)
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

    // ── 逐契约摘标记：对**每一个**声明 id 各测一次减法向 ──
    //
    // 为什么逐契约而不是只测一条：谓词里可以掺一个**写死某个契约 id**（`|| r.id === 'rule-timeout'`）
    // 的析取项 —— 它在真产出上与 `r.anchor` 重合 ⇒ 第 1 条看不见、单点合成产出也可能看不见，
    // 只在**正好摘掉它护着的那一个 id** 时露出来。
    //
    // 诱饵条目是第二个载体：以别的字段为键的析取项（`r.anchor || !r.passed`）在今天的真产出上
    // 恒等于 `r.anchor`（40 条契约今天全 PASS），故塞一条**非 anchor 且 FAIL** 的合成条目进去。
    const baitId = 'zz-probe-bait-contract'
    for (const target of ANCHOR_CONTRACT_IDS) {
      vi.mocked(runEval).mockReturnValueOnce({
        ...real,
        results: [
          ...real.results.map((r) => (r.id === target ? { ...r, anchor: undefined } : r)),
          {
            id: baitId,
            description: '合成诱饵契约（非 anchor，且 FAIL）',
            passed: false,
          },
        ],
      })
      const stripped = inlinedAnchorIds()
      expect(stripped).not.toContain(target)
      expect(stripped).not.toContain(baitId)
      // 「恰好少这一个」：其余一条不多、一条不少 —— 顺序也照产出。
      expect(stripped).toEqual(baseline.filter((id) => id !== target))
    }

    // clos2（F2 闭包）：把**抽取输出**钉在真产出算出的 `baseline` 上。探测探针（读到合成
    // id 就照声明集作答）在**没有 `zz-`** 的那次调用上返回声明集，而真删一处 `anchor: true`
    // 之后声明集 ≠ `baseline` ⇒ 红（R4 实测：本行缺席时 F2 载体 4 绿，在场则红）。
    //
    // **与 clos1 的关系（R5 订正，存在性而非顺序）**：两条闭包**各自只闭一个方向、互不覆盖**，
    // 且**与两条断言在文件里的先后位置无关**。clos2 的 `baseline` 由 `real = runEval()` 派生，
    // 而 clos1 读的是 `ANCHOR_CONTRACT_IDS` —— 两者之间**没有蕴含关系**，clos1 绿**不**蕴含
    // `baseline` 来自真产出（R5 实测：`heal_nonenum` 载体下 clos1 绿、`baseline` 已被污染 ——
    // **不带**真降级时本文件 4 绿，**带**真降级 `:405` 时 1 failed（红在 clos3）；两个读数说的是
    // 同一件事：clos1 绿**不**蕴含 `baseline` 来自真产出）。把本行挪到 clos1 **之后**、
    // 再叠一次真降级 `:405`，红绿**不变**
    //（R5 实测两格：无载体 ⇒ 仍 `EXIT 1 / 3 failed`；`heal_nonenum` 载体 ⇒ 仍 `EXIT 1 / 1 failed`）。
    expect(inlinedAnchorIds()).toEqual(baseline)

    // clos3（R5）：`anchor → role` 的派生必须覆盖**声明的每一个 id**。
    //
    // `eval-harness.ts` 末尾的 `for (const r of results) if (r.anchor) r.role = 'anchor'`
    // 是**函数里的最后一段**。任何 `results.push(...)` 落在它**之后** ⇒ 该契约
    // `role === undefined` ⇒ **退出 anchor 保护**（生产上 `runEval` 的 `anchorFailures`、
    // `crsi-modify` 的 `regressedAnchors` 过滤的都是 `role === 'anchor'`）。
    // 具体失败场景（R5 实测）：把 `blast-radius-gate` 的 push 挪到角色循环之后**并让它真的 FAIL**
    // ⇒ `runEval()` 报 `passed 39 / score 98`、该契约**没有 `role`**，而 `anchor-gate`
    // **仍然 `passed: true`**；修前本文件**静默 4 绿**，本行在场则红。
    // 修前全量套件里唯一抓到这一形态的**不是**任何锚 `role` 的断言，而是**总分**断言
    // （`test/core/eval-harness.test.ts` 的 `reports a full score…`，红在 `expected 39 to be 40`）；
    // 锚 `self-report-diagnostic` 的 `role` 那条**没有红** —— 被移动的是另一个契约（R5 实测）。
    // 更关键的是**总分不变**的那一形态：让 `blast-radius-gate` 的 push 留在原处、只是不被角色循环
    // 回填（`if (r.anchor && r.id !== 'blast-radius-gate')`）⇒ `runEval()` 仍是 `passed 40 / score 100`、
    // 该契约 `passed: true` 而无 `role` ⇒ **修前全量套件 250 文件 / 2935 测试全绿、彻底无声**
    //（R5 实测；本行在场则红）。故本条覆盖的是「分数看不出来的那种角色丢失」。
    //
    // 边界（登记）：它读的是**派生结果**（`role` 已被回填），不是定义处的 `anchor` 标记本身 ——
    // 与 clos1/clos2 一样是**单向**闭包，它不检查 `role` 是否被**错误地**回填给非 anchor 契约。
    expect(
      runEval().results.filter((r) => ANCHOR_CONTRACT_IDS.has(r.id) && r.role !== 'anchor'),
    ).toEqual([])

    // 桩已全部过期 ⇒ 抽取回到真产出。（这一条**只是**桩生命周期的读数：它问的是集合里有没有
    // `rule-timeout`，而由声明构造的自制报告里当然也有它 —— 委派的机械证据在下面的投影比较。）
    // 边界（登记，不主张覆盖）：`'rule-timeout'` 是**夹具里挑的一个字面量** —— 它不给这个 id
    // **独有**覆盖。它贡献的红是**一条可被别的声明 id 替换的冗余红**：真删掉
    // `rule-timeout` 的 `anchor: true` ⇒ 本行是第 3 条里最先红的那一条（出货件 R5 实测：3 failed）；
    // 把本行与探针那两处（过滤 + 断言，共 3 处）的字面量换成另一个**已声明**的 anchor id
    // ⇒ 出货件转 **2 failed**、第 3 条整体转绿（R5 实测：换成 `'rule-git-force'`）⇒ 那一条红正是它。
    // 换的目标必须是**已声明**的 anchor id：换成非 anchor 的 id 会让本行的预期落空，那是另一条红。
    // 本文件上这一对是 3 failed **对** 3 failed —— 因为 clos3 在本行**之前**先红，而 vitest 的
    // `expect` 一失败就中止本条 `it` 的后续断言（本行与末尾投影比较那**两次** `runEval()` 调用
    // 都被跳过 —— R5 复评用 mock 侧计数器实测：9 → **7**，不是 8）。别把「这里出现过它」读成
    // 「它被测到了」；**逐条**覆盖声明 id 的是上面那个逐契约循环。
    expect(inlinedAnchorIds()).toContain('rule-timeout')

    // ── 委派自检：本条（以及第 1/2/4 条）用的必须是**真实现** ──
    //
    // `vi.importActual` 绕过本文件的 mock 取真实模块，再把它的产出与 mock 的产出按**显式投影**
    // （`id` / `passed` / `anchor === true` / `role`）逐条比。这一条是「工厂没被换成自制报告」
    // 在**产出一侧**的机械证据 —— **不是本文件里唯一读 `runEval()` 的断言**（第 2 条直接读它的
    // 产出、第 4 条的 `inlined` 也走抽取、clos2/clos3 也读），而是**与真实现比产出**的那一条：
    // 一份**由 `ANCHOR_CONTRACT_IDS` 构造的**自制报告与声明自洽、与真产出同形 ⇒ 上面每一条
    // （含探针与逐契约摘标记）都绿，而真实现一次都没被调到（R3 实测：4 passed）。
    // **投影比的是四个字段，不是整个对象**：`description` 或新增字段的漂移它**看不见**
    // （登记边界）；换来的是**读取路径与比较路径是同一条** —— `anchor === true` 是属性访问，
    // 与抽取器同路，故非枚举属性 / 读时 getter 这类伪装在这里现形（§上方文件头第二条残留轴）。
    // 它**只比产出**：工厂把声明侧改写时这里的返回值仍然相同 ⇒ 抓那条的是上面的 clos1。
    //
    // 挂起的 `mockReturnValueOnce`（例如抽取被记忆化 —— 那样某次读不消费桩）不会让任何断言
    // **静默变绿**：读到合成产出的断言必然与声明集不等（合成产出总是少一个声明 id、或多一个
    // 合成 id），只会让**更多**断言红（实测：记忆化 ⇒ 本条红，第 4 条仍按真值判、全绿）。
    // 更深的「这次调用一定排空队列」**不主张** —— 一次调用只吃掉队首一个，多个挂起时剩下的
    // 会落到第 4 条，而那也是红、不是绿。代价是这里每次多跑一次 `runEval()`
    //（只读、无写入：`buildIsolatedComponents()` 指向 tmpdir）。
    const original = await vi.importActual<typeof import('../../src/core/eval-harness')>(
      '../../src/core/eval-harness',
    )
    // clos1（F1 闭包）：把**声明侧**钉在 `importActual` 拿到的真值上 —— 与工厂怎么算
    // `ANCHOR_CONTRACT_IDS` 无关 ⇒ **结构性闭包**。工厂改成「由 `runEval()` 派生声明」时，
    // 上面第 1 条的**两侧一起移动** ⇒ 集合比较按构造相等、本文件 4 绿（R4 实测：产出一侧
    // 仍真委派 ⇒ 紧随的投影比较也绿）。对比的是**声明**，不是产出 ⇒ 与投影比较是两条不同的判据。
    //
    // **与 clos2 的关系（R5 订正，存在性而非顺序）**：clos1 与 clos2 **各自只闭一个方向、
    // 互不覆盖**，且**与两条断言的先后位置无关**。clos1 守的是「**声明**没被改写」，它
    // **不**守「clos2 的 `baseline` 来自真产出」—— 这两件事之间没有蕴含关系（R5 实测：
    // `heal_nonenum` 载体下本行绿、而 `baseline` 已被污染，本文件仍 4 绿）。
    // 把 clos2 那行挪到本行**之后**也不改变红绿 —— 与上面 clos2 侧所引的是同两格
    //（R5 实测：无载体 / `heal_nonenum` 载体 + 真降级 `:405` ⇒ 都仍 `EXIT 1`）。
    expect([...ANCHOR_CONTRACT_IDS]).toEqual([...original.ANCHOR_CONTRACT_IDS])

    // ── 产出侧同一性（见文件头）：**显式投影比较** ──
    //
    // 旧写法是 `expect(runEval()).toEqual(original.runEval())`。它的问题不是「不够深」，而是
    // **读取路径与比较路径不是同一条**：抽取器读 `r.anchor` 走属性访问，`toEqual` 走的是
    // **可枚举自有属性**的枚举 —— 伪装正好落在两条路径之间（R5 实测：非枚举自有属性 /
    // 读时 getter 的产出在旧写法下 4 绿，连真删一处 `anchor: true` 也无信号）。
    // 投影逐条读**同样的四个字段**（`anchor === true` 即属性访问），把两条路径并成一条。
    // 边界（登记）：① 它仍是**比较型**判据 ⇒ 闭不掉「只在被比较的那次调用上说真话」的
    // 有状态载体（文件头第三条残留轴）；② 投影**只有四个字段** ⇒ `description` 等的漂移
    // 不在覆盖面内。
    const project = (r: { id: string; passed: boolean; anchor?: boolean; role?: string }) => [
      r.id,
      r.passed,
      r.anchor === true,
      r.role,
    ]
    expect(runEval().results.map(project)).toEqual(original.runEval().results.map(project))
  })

  it('判据能失败（负控）：把一个 id 拼错会被抓出两条', () => {
    // 本条覆盖的是**判据本体**（`anchorSetMismatch`）：它把**声明侧**敲错一处再喂给同一条
    // 判据，故抽取被改写成自洽形式时它**照样报出期望的两条**（自洽形态下 `declared` 与
    // `inlined` 本就相等，typo 与它的差恰好就是「一缺一多」）。抽取那一步的守卫在上面
    // 「空转守卫」条里。
    //
    // 边界（登记，**不**主张覆盖）：`declared` 取自声明、`inlined` 取自产出 ⇒ 本条是这对
    // 集合的**第三个探针**（前两个是第 1 条与第 3 条），**不是第四条独立的网** —— 声明侧
    // 与产出一同被改写时它跟着第 1 条一起绿。「不是抽取步骤」只是**分工**、不是免疫：
    // 下面 `inlined` 那一行就来自抽取器，抽取被改写时本条的输入跟着变。
    // 另：下面的 `'blast-radius-gate'` 是**夹具里挑的一个字面量** —— 它不给这个 id
    // **独有**覆盖：它是同一个字面量的**三处拷贝**（`typo` 那行与下面两条期望串），三处一起
    // 换成别的**已声明** id ⇒ 本文件 4 passed、一条不红（R5 实测：换成 `'rule-git-force'`）。
    // 别把「这里出现过它」读成「它被测到了」。
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
