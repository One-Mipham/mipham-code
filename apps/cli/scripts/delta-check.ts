// delta-check.ts — 一次性脚本（throwaway，不提交）。
// 验证 M2 任务表现评估的「弱 skill → fail、强 skill → pass」delta 真实非零。
// 运行：cd apps/cli && bun run scripts/delta-check.ts
// 前置：~/.mipham/config.yml 已配好 provider + apiKey（走 loadConfig 解密）。
import { loadConfig } from '../src/config/loader'
import { bootstrapProviders } from '../src/providers/bootstrap'
import { runTaskPerformance } from '../src/core/task-performance'

const config = loadConfig()
const llm = bootstrapProviders(config.providers, config.defaultProvider, config.defaultModel)

// 强 skill = safe-coding.SKILL.md 的正文（含输入校验规则）
const strong = `处理外部/用户输入前必须校验：null、undefined、空字符串、格式非法时，抛出 RangeError，消息为 'invalid input'。`
// 弱 skill = 无校验规则的一次性字符串
const weak = `你是一个编码智能体，尽力完成任务即可。`

async function main(): Promise<void> {
  console.log(`provider=${config.defaultProvider} model=${config.defaultModel}\n`)

  const strongReport = await runTaskPerformance(llm, {
    skill: { name: 'safe-coding', text: strong },
  })
  const weakReport = await runTaskPerformance(llm, {
    skill: { name: 'safe-coding', text: weak },
  })

  console.log(`强 skill: ${strongReport.score}/100 (${strongReport.passed}/${strongReport.total})`)
  for (const r of strongReport.results) {
    console.log(
      `  ${r.id} → ${r.passed ? '✅ pass' : '❌ fail'}${r.detail ? ` — ${r.detail.slice(0, 80)}` : ''}`,
    )
  }
  console.log(`弱 skill: ${weakReport.score}/100 (${weakReport.passed}/${weakReport.total})`)
  for (const r of weakReport.results) {
    console.log(
      `  ${r.id} → ${r.passed ? '✅ pass' : '❌ fail'}${r.detail ? ` — ${r.detail.slice(0, 80)}` : ''}`,
    )
  }
  console.log(`\ndelta = ${strongReport.score - weakReport.score}（> 0 即机制验证通过）`)
}

main()
