/**
 * 分类器裁决的本地台账 —— `~/.mipham/permission-audit.jsonl`。
 *
 * **为什么需要它。** 设计文档 §3.7（决策 5）与风险 8 记着同一条：子代理与后台是
 * **无人值守**的（后台 / worktree / daemon 共用 `sub-agent.ts` 那条路径），而那道闸门
 * 只有**拒绝**的通知路径 —— **放行是无声的**。`source: 'classifier'` 在
 * `resolveApproval()` 里被造出来，随后只在**拒绝**分支上被两个闸门读走
 * （`engine.ts` / `sub-agent.ts` 的 `decision.source === 'classifier'` 都嵌在拒绝那一支），
 * 放行那一支的这个字段直接丢掉：没有会话日志事件、没有 metrics 计数器、也没有 hook 事件。
 * 于是「`auto` 档到底批过什么」在本机没有任何一处读得出来。
 *
 * **为什么记在 `resolveApproval()` 里。** 那里是裁决的**出生地**，也是唯一一个天然覆盖
 * 全部闸门的点：今天两个（`engine.ts` / `sub-agent.ts`），将来第三个也自动在内。反过来把
 * 记录挂在两个闸门上，就是本仓库反复出现的那族缺陷的形状 —— 两条路径只接一条。更要紧的是
 * 第二条理由：**子代理根本没有 `SessionLog`**（`SubAgent` 的构造函数里没有这个参数），
 * 所以「走会话日志事件」这条更整齐的路在子代理那里无路可走，除非给它新拉一条日志管线。
 * 这是相对原计划的一处**偏离**：原计划写的是会话日志事件，实测后改为这里的**模块级台账**
 * （session-log 的 `checker/decision` 是同类先例，但那条先例只覆盖引擎，覆盖不到子代理）。
 *
 * **记什么、不记什么。** 只记「哪次调用、谁裁的、裁成什么、为什么」—— **绝不记工具入参**。
 * 入参里会有文件正文、命令行、凭据片段。分类器的 `reason` 是模型生成的一句话，可能复述
 * 入参，但它落在本机 0600 的文件里、不上网。这**不构成新的暴露面**：同一次调用在会话日志里
 * 本来就以全量入参 + 全量结果的形式落盘了（`session-log.ts` 的「model-visible means logged」），
 * 台账严格更少；子代理那条路径虽然没有会话日志，但仍是本机 0600、不经网络。
 * **边界（是取舍，不是遗漏）**：没有入参 ⇒ 「`auto` 放行了哪一条 Bash」只能从 `reason` 里读，
 * 读不到命令原文。要还原到那一层请去会话日志（引擎路径有，子代理路径没有）。
 *
 * **一条裁决 = 一行，不是一次执行 = 一行。** 记录写在分类器**真的被咨询**的那两处；
 * `classifierCache` 命中**不写** —— 那时分类器根本没被问到（`resolveApproval()` 在调用它
 * 之前就从缓存返回了），写一行等于声称有一个没人做过的裁决。反过来读：台账回答的是
 * 「分类器裁过什么」，不是「某条命令跑了几次」；执行次数要问 gate 侧的指标或会话日志。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PermissionLevel, PermissionMode } from '../shared/index.ts'
import type { PermissionDenialReason } from './permission'
import { appendRegularFileSync } from '../shared/regular-file'
import { miphamHome } from './paths.ts'

/** 一条分类器裁决。 */
export interface ClassifierRulingRecord {
  /** ISO 时间戳。 */
  at: string
  /** 裁决时的档位。今天只可能是 `'auto'`，写上它是为了让记录自证而不是靠读者推断。 */
  mode: PermissionMode
  tool: string
  /** **分类器说了什么。** */
  verdict: 'allow' | 'deny'
  /**
   * **这一支最终落定的档位。** 分类器放行后仍可能是 `'ask'` —— 放行走的是
   * `allowRuleDecision()`，组织级 `maxAllowedMode` 会在那里封顶（`resolveApproval` 第 4 步）。
   * 那种记录读作「分类器同意、上限否决」，`verdict` 与 `level` 两个字段合起来才说得清。
   */
  level: PermissionLevel
  /** 分类器自己的一句话理由（模型生成 —— 见文件头「记什么」）。缺省不写该键。 */
  reason?: string
  /** 仅拒绝：`true` ⇒ 引擎故障拿住，**不是策略决定**，重试是对的。缺省不写该键。 */
  retryable?: boolean
  /** 仅拒绝：拒绝的类别（策略拒绝是 `'classifier-deny'`）。缺省不写该键。 */
  denialReason?: PermissionDenialReason
}

/**
 * 台账路径。**每次现算**，不存模块级常量 —— 测试对 `node:os` 的 `homedir` mock
 * （全局 `vitest.setup.ts` 与文件级 `vi.mock` 两种）都因此一定生效，且不必依赖
 * import 求值与 mock hoisting 的先后。`eval-harness.ts` 用模块级常量也能成立，
 * 但那是「恰好也对」，这里不复制那个形状。
 */
export function permissionAuditPath(): string {
  return miphamHome('permission-audit.jsonl')
}

/** 整个进程只说一次 —— 见 `recordClassifierRuling` 的失败分支。 */
let warnedOnce = false

/**
 * 追加一条裁决。**永不抛。**
 *
 * 一次台账写失败不该掀翻一次工具调用（可用性优先），但**也不能静默地失败** ——
 * 这个模块存在的全部意义就是消掉「无声」，若写不进去还一声不响，等于把无声又装了回来。
 * 折中是：调用方看不到异常，第一次失败往 stderr 说一句，之后不再重复。stderr 是本仓库
 * 既有的告警通道（`hooks.ts` / `workspace-trust.ts` 同形）。
 */
export function recordClassifierRuling(record: Omit<ClassifierRulingRecord, 'at'>): void {
  try {
    const file = permissionAuditPath()
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    // 台账路径上是个 FIFO 时**不写**也**不挂**（`appendFileSync` 会打开它写 ⇒ 等到有
    // 读者为止）：当成一次写失败，走下面那条「第一次说一句」的路。
    if (
      !appendRegularFileSync(
        file,
        JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n',
        { mode: 0o600 },
      )
    ) {
      throw new Error(`${file} is not a regular file`)
    }
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true
      process.stderr.write(
        `⚠️  分类器台账写不进去（之后不再重复报告）: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }
}

/**
 * 读回全部裁决。**撕裂行只跳过那一行** —— 写到一半进程被杀会留半行 JSON，
 * 读侧不能因此整份报废（`improvement-track.ts` 的同形处理）。
 */
export function readClassifierRulings(): ClassifierRulingRecord[] {
  const file = permissionAuditPath()
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ClassifierRulingRecord]
      } catch {
        return []
      }
    })
}
