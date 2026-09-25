#!/usr/bin/env bun
/**
 * Sync count constants from their true sources → the three stored copies.
 *
 * 真源（前三个在**进程内**算出，不联网、不跑套件）：
 *   - SLASH_COMMAND_COUNT ← getCommandNames().length    (src/ui/commands.ts)
 *   - PROVIDER_COUNT      ← DEFAULT_PROVIDERS.length    (src/shared/constants.ts)
 *   - TOOL_COUNT          ← createToolRegistry().size   (src/tools/index.ts)
 *   - TEST_COUNT          ← 一次真套件跑的自报总数（只能由 vitest JSON 报告给出）
 *
 * 写往三处：
 *   - packages/shared/package-info.json     (两个官网 + 共享包消费的那份)
 *   - packages/shared/src/package-info.ts   (共享包源码)
 *   - apps/cli/src/shared/package-info.ts   (CLI 自包含副本；二进制不能 import 共享包)
 *
 * Usage:
 *   bun run scripts/sync-counts.ts                              # 写出前三个数
 *   bun run scripts/sync-counts.ts --test-report coverage/vitest-report.json   # 连测试数一起写
 *   bun run scripts/sync-counts.ts --check                      # 只比对，不写；不一致则 exit 1
 *
 * 那份 JSON 报告由 `pnpm coverage` 产出（它的脚本里已挂 `--reporter=json`，落在
 * 已 gitignore 的 `coverage/` 下）。**不要**写成 `pnpm test -- --reporter=json …` ——
 * pnpm 9.15 会把那个 `--` **原样**传给 vitest（实测命令行为
 * `vitest run "--" "--reporter=json" …`）⇒ 参数不生效、报告不产出，而退出码还是 0。
 *
 * 为什么测试数要**外部给报告**、而不是本脚本自己跑一次套件：全量套件要几分钟，
 * 而本脚本会被顺手调用（改了一个命令就想对齐数字）。把它做成「每次都跑几分钟」
 * 等于没人会跑，于是数字照样靠手改。测试数的**真值**由 CI 的 Test job 守着
 * （硬门禁：套件自报总数 ≠ 落盘值即红），本脚本只是**把它写下去的那支笔**。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname)
const REPO_DIR = resolve(SCRIPT_DIR, '../../..')

/** 三个进程内计数的名单（真源见文件头）。测试数单独走，因为它没有进程内真源。 */
type InProcessKey = 'SLASH_COMMAND_COUNT' | 'PROVIDER_COUNT' | 'TOOL_COUNT'

const IN_PROCESS_KEYS: InProcessKey[] = ['SLASH_COMMAND_COUNT', 'PROVIDER_COUNT', 'TOOL_COUNT']

const TS_FILES = [
  resolve(REPO_DIR, 'packages/shared/src/package-info.ts'),
  resolve(SCRIPT_DIR, '../src/shared/package-info.ts'),
]
const JSON_FILE = resolve(REPO_DIR, 'packages/shared/package-info.json')

async function computeInProcessCounts(): Promise<Record<InProcessKey, number>> {
  const [commands, constants, tools] = await Promise.all([
    import('../src/ui/commands.ts'),
    import('../src/shared/constants.ts'),
    import('../src/tools/index.ts'),
  ])
  return {
    SLASH_COMMAND_COUNT: commands.getCommandNames().length,
    PROVIDER_COUNT: constants.DEFAULT_PROVIDERS.length,
    TOOL_COUNT: tools.createToolRegistry().size,
  }
}

/** 从 vitest 的 JSON 报告里取**总测试数**（含 skipped —— 本机与 CI 的 passed/skipped 切分不同）。 */
function readTestTotal(reportPath: string): number {
  let report: unknown
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf-8'))
  } catch (err) {
    throw new Error(`读不了测试报告 ${reportPath}：${err}`)
  }
  const total = (report as { numTotalTests?: unknown }).numTotalTests
  if (typeof total !== 'number' || !Number.isInteger(total) || total <= 0) {
    throw new Error(
      `${reportPath} 里没有可用的 numTotalTests（读到 ${JSON.stringify(total)}）—— ` +
        `请确认是用 \`--reporter=json\` 产出的报告`,
    )
  }
  return total
}

/**
 * 在源码里替换 `export const <KEY> = <数字> as const`。
 * 匹配不到就抛 —— 否则正则与文件脱节时本脚本会**静默什么都不改**。
 */
function rewriteTs(source: string, key: string, value: number): string {
  const re = new RegExp(`(export const ${key} = )\\d+( as const)`)
  if (!re.test(source)) {
    throw new Error(`未找到 ${key} 的 \`export const ${key} = <n> as const\` —— 正则已与文件脱节`)
  }
  return source.replace(re, `$1${value}$2`)
}

function readTsValue(source: string, key: string): number {
  const m = source.match(new RegExp(`export const ${key} = (\\d+) as const`))
  if (!m) throw new Error(`未找到 ${key} 的声明`)
  return Number(m[1])
}

function rewriteJson(raw: string, updates: Record<string, number>): string {
  const data = JSON.parse(raw) as Record<string, unknown>
  for (const [key, value] of Object.entries(updates)) data[key] = value
  return JSON.stringify(data, null, 2) + '\n'
}

async function main() {
  const args = process.argv.slice(2)
  let checkOnly = false
  let reportPath: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') checkOnly = true
    else if (args[i] === '--test-report' && args[i + 1]) reportPath = args[++i]
    else {
      console.error(`未知参数：${args[i]}`)
      process.exit(2)
    }
  }

  const computed = await computeInProcessCounts()
  const updates: Record<string, number> = { ...computed }
  if (reportPath) updates.TEST_COUNT = readTestTotal(reportPath)

  const jsonRaw = readFileSync(JSON_FILE, 'utf-8')
  const jsonData = JSON.parse(jsonRaw) as Record<string, unknown>
  const tsSources = TS_FILES.map((f) => readFileSync(f, 'utf-8'))

  // 比对：每个「应当写下去的数」都必须已经等于真源。
  const mismatches: string[] = []
  for (const [key, value] of Object.entries(updates)) {
    const stored = jsonData[key]
    if (stored !== value) mismatches.push(`${JSON_FILE}: ${key} = ${stored}，真源 = ${value}`)
    for (let i = 0; i < TS_FILES.length; i++) {
      const inFile = readTsValue(tsSources[i]!, key)
      if (inFile !== value) mismatches.push(`${TS_FILES[i]}: ${key} = ${inFile}，真源 = ${value}`)
    }
  }

  if (!reportPath) {
    const stored = jsonData.TEST_COUNT
    console.log(
      `ℹ️  未给 --test-report ⇒ TEST_COUNT 不参与本次比对/写入（落盘值 ${stored}）。` +
        `\n   要更新它：cd apps/cli && pnpm coverage` +
        `\n   再重跑本脚本并加 --test-report coverage/vitest-report.json`,
    )
  }

  const summary = IN_PROCESS_KEYS.map((k) => `${k}=${computed[k]}`).join(' ')
  if (checkOnly) {
    if (mismatches.length > 0) {
      console.error(`❌ 计数字面量与真源不一致：\n   ${mismatches.join('\n   ')}`)
      process.exit(1)
    }
    console.log(
      `✅ 计数与真源一致（${summary}${reportPath ? ` TEST_COUNT=${updates.TEST_COUNT}` : ''}）`,
    )
    return
  }

  if (mismatches.length > 0) {
    console.log(`✍️  将修正 ${mismatches.length} 处：`)
    for (const m of mismatches) console.log(`   • ${m}`)
  }

  writeFileSync(JSON_FILE, rewriteJson(jsonRaw, updates))
  for (let i = 0; i < TS_FILES.length; i++) {
    let src = tsSources[i]!
    for (const [key, value] of Object.entries(updates)) src = rewriteTs(src, key, value)
    writeFileSync(TS_FILES[i]!, src)
  }

  console.log(
    `✅ 已写 ${Object.keys(updates).length} 个数 → package-info.json + 两份 package-info.ts`,
  )
  console.log(`   ${summary}${reportPath ? ` TEST_COUNT=${updates.TEST_COUNT}` : ''}`)
  console.log('   别忘了 pnpm format —— 两份 .ts 是 prettier 管的。')
}

void main()
