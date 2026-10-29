/**
 * 出处判定：「这个数是你量出来的，还是你推出来的？」
 *
 * 只判一种主张 —— **带计数单位的数量**（`4,572 测试` / `343 files` / `1,834 个字符`）。
 * 版本号、端口、日期、行号都不是计数，代码里的数字是在引用而不是在下结论。
 *
 * 出处的定义刻意收窄到**本轮的工具结果**（与用户这句话）：模型自己前一轮写下的数
 * 不算出处 —— 那正是「先猜一个、再当事实复述」的形态，也是这条纪律要拦的东西。
 */

export interface CountClaim {
  /** 去掉千分位后的数字 —— 判定身份用这个 */
  digits: string
  /** 原文片段（数字 + 单位），好让提示语点名质疑的是哪一处 */
  context: string
}

/** 计数单位。长的写在前面：正则按顺序试，`字符` 先于 `字` 才能整词匹配。 */
const UNITS = [
  '行代码',
  '字符',
  '字节',
  '文件',
  '测试',
  '用例',
  '提交',
  '端口',
  'characters',
  'character',
  'chars',
  'char',
  'bytes',
  'tokens',
  'commits',
  'entries',
  'entry',
  'lines',
  'line',
  'tests',
  'test',
  'cases',
  'case',
  'files',
  'file',
  'items',
  'item',
  'passes',
  'pass',
  'runs',
  'run',
  '个',
  '条',
  '笔',
  '次',
  '行',
  '处',
  '项',
  '种',
  '轮',
  '份',
  '张',
  '位',
  '家',
  '字',
]

const UNIT_ALT = UNITS.join('|')
/** 3 位以上（`343`）或带千分位（`4,572`）—— 一两位的数字太容易是序号而非计数。 */
const NUMBER = '(\\d{1,3}(?:,\\d{3})+|\\d{3,})'
const CLAIM_RE = new RegExp(`${NUMBER}\\s*(?:${UNIT_ALT})(?![a-z])`, 'gi')

/** 代码块与行内代码里的数字是在引用，不是在下结论。 */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
}

function normalize(digits: string): string {
  return digits.replace(/,/g, '')
}

/**
 * 从回复里挑出「没有出处」的计数主张。
 *
 * @param reply 本轮最终回复（模型自己的话）
 * @param evidence 本轮的工具结果 + 用户这句话
 */
export function unprovenCountClaims(reply: string, evidence: string): CountClaim[] {
  const prose = stripCode(reply)
  const haystack = evidence.replace(/,/g, '')
  const seen = new Set<string>()
  const claims: CountClaim[] = []

  for (const match of prose.matchAll(CLAIM_RE)) {
    const digits = normalize(match[1]!)
    if (digits.length < 3) continue
    // 「第 1234 行」是位置不是数量 —— 它指的是哪一行，不是有多少行。
    const before = prose.slice(0, match.index).trimEnd()
    if (before.endsWith('第')) continue
    if (seen.has(digits)) continue
    if (new RegExp(`(?<!\\d)${digits}(?!\\d)`).test(haystack)) continue
    seen.add(digits)
    claims.push({ digits, context: match[0].trim() })
  }

  return claims
}
