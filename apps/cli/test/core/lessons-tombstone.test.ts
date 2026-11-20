import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InstructionsLoader } from '../../src/core/instructions'

const LESSON = '## tombstone-alpha: 唯一标记\n- 建议: 先读代码再改\n- 严重度: critical\n'

/**
 * 删除必须**立刻**生效。
 *
 * 教训摘要此前只在 `loadAll` 时读一次并缓存；会话中途删掉一条教训，系统提示里那条
 * 会一直留着 —— 与 Agnes Harness 报告 Limitations 第 3 条同型的「删了没有墓碑」。
 * 判据用唯一标记串，避免误撞仓库里已有的教训。
 */
describe('教训删除的即时性', () => {
  it('删掉一条教训后，下一次投影里不再出现它', () => {
    const repo = mkdtempSync(join(tmpdir(), 'mipham-lessons-tombstone-'))
    try {
      execSync('git init', { cwd: repo, stdio: 'ignore' })
      mkdirSync(join(repo, 'apps/cli'), { recursive: true })
      const file = join(repo, 'apps/cli/crsi-lessons.md')
      writeFileSync(file, LESSON)

      const loader = new InstructionsLoader()
      loader.loadAll(repo)
      expect(loader.buildSystemPrompt()).toContain('tombstone-alpha')

      writeFileSync(file, '')

      expect(loader.buildSystemPrompt()).not.toContain('tombstone-alpha')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
