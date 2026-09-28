/**
 * GitHub Actions 的 `uses:` 必须钉到**不可变的 commit SHA**。
 *
 * 为什么：`uses: actions/checkout@v5` 里的 `v5` 是一个**可被移动的 ref**。上游
 * （或任何拿到该仓库写权限的人）把它指向另一个 commit，我们下一次 CI 跑的就是
 * 另一份代码 —— 而工作流里握着 npm 的 OIDC 发布权、GITHUB_TOKEN 与 release 资产
 * 的上传权。这是供应链里唯一一处「我们没有按下按钮，代码却换了一份」的入口。
 *
 * 与 `.github/dependabot.yml` 不冲突：Dependabot 的 `github-actions` 生态**认得**
 * SHA 形式，并会照 `# vN` 注释提出升版 PR。注释因此不是装饰 —— 它同时是给人看的
 * 版本标签和给 Dependabot 看的比较基准，所以本守卫也断言它在位。
 *
 * 本文件**只**管这一件事。CI job 集合、测试数、版本号各有专门守卫，重复断言只会
 * 让一处改动要改多个地方。
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CLI_DIR = join(import.meta.dirname, '..', '..')
const WORKFLOW_DIR = join(CLI_DIR, '..', '..', '.github', 'workflows')

/** 一条 `uses:` 的三种写法都收：`- uses: X`、`  uses: X`、带引号。 */
const USES_LINE = /^[ \t]*(?:-[ \t]+)?uses:[ \t]*(\S+)[ \t]*(#.*)?$/gm

interface UseEntry {
  file: string
  ref: string
  comment: string | null
}

function workflowFiles(): string[] {
  if (!existsSync(WORKFLOW_DIR)) return []
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
}

function useEntries(): UseEntry[] {
  const found: UseEntry[] = []
  for (const file of workflowFiles()) {
    const src = readFileSync(join(WORKFLOW_DIR, file), 'utf-8')
    for (const m of src.matchAll(USES_LINE)) {
      found.push({ file, ref: m[1]!, comment: m[2] ?? null })
    }
  }
  return found
}

/** 本地 action（`./path`）与 docker 引用不适用 SHA 规则。 */
const isLocalOrDocker = (ref: string): boolean =>
  ref.startsWith('./') || ref.startsWith('docker://')

describe('.github/workflows 的 action 引用', () => {
  it('能枚举到工作流与 uses（空转守卫）', () => {
    // 枚举为空的话，下面逐条断言会零次通过 —— 先钉住这一点。
    // 路径写错、文件改名、正则太严，都只会让枚举变空，而那看起来和「全部合规」一样。
    expect(existsSync(WORKFLOW_DIR), `${WORKFLOW_DIR} 不存在`).toBe(true)
    expect(workflowFiles().length).toBeGreaterThan(0)
    expect(useEntries().length).toBeGreaterThan(0)
  })

  it('解析不漏行：解析出的条数 == 源码里 uses: 的裸行数', () => {
    // 这条是本文件的**正对照**：正则若把某种写法漏掉（多写了 `- `、引号、制表符），
    // 漏掉的那些在下面那条断言里根本不会出现，于是「全部合规」是假的。
    const raw = workflowFiles().reduce((n, file) => {
      const src = readFileSync(join(WORKFLOW_DIR, file), 'utf-8')
      return n + (src.match(/uses:/g)?.length ?? 0)
    }, 0)
    expect(useEntries().length).toBe(raw)
  })

  it('每一条都钉在 40 位 commit SHA 上', () => {
    const offenders = useEntries()
      .filter((e) => !isLocalOrDocker(e.ref))
      .filter((e) => !/@[0-9a-f]{40}$/.test(e.ref))
      .map((e) => `${e.file}: ${e.ref}`)
    expect(offenders, `未钉 SHA 的 action 引用：\n${offenders.join('\n')}`).toEqual([])
  })

  it('每条 SHA 都带 `# vN` 版本注释 —— Dependabot 与人都靠它', () => {
    const offenders = useEntries()
      .filter((e) => !isLocalOrDocker(e.ref))
      .filter((e) => !/@[0-9a-f]{40}$/.test(e.ref) || !/^#\s*v\d+/.test(e.comment ?? ''))
      .map((e) => `${e.file}: ${e.ref} ${e.comment ?? '(无注释)'}`)
    expect(offenders, `缺版本注释的 SHA 引用：\n${offenders.join('\n')}`).toEqual([])
  })
})

describe('CI 入口冒烟：构建产物自己说得清自己是谁', () => {
  it('ci.yml 里有跑 `--help` / `--version` 的步骤', () => {
    // 为什么单独说一句：`bun build --compile` 成功**不等于**产物能跑 —— 打包期
    // 解析不了的入口、缺的内嵌资产、坏掉的 commander 注册表，都要等第一次真正
    // 执行才现形。发布链路上这是最后一道能在打 tag 之前说话的检查。
    const ci = readFileSync(join(WORKFLOW_DIR, 'ci.yml'), 'utf-8')
    expect(ci).toContain('--version')
    expect(ci).toMatch(/--help/)
  })
})
