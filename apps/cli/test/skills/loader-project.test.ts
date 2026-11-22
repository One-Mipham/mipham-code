/**
 * 项目级技能：`.mipham/skills/` 是产品文案让用户放技能的地方
 * （`/project`、Skill 工具的 not-found 提示、`loop-scaffold` 都这么写），
 * 但启动与 `/reload-skills` 从不扫描它。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SkillsLoader } from '../../src/skills/loader'

let dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mipham-skill-project-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function writeSkill(path: string, name: string): void {
  writeFileSync(path, `---\nname: ${name}\ndescription: d\n---\nbody of ${name}\n`, 'utf-8')
}

describe('SkillsLoader.loadProjectSkills', () => {
  it('读取 <root>/.mipham/skills/ 下的平铺技能', () => {
    const root = tmp()
    const skillsDir = join(root, '.mipham', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    writeSkill(join(skillsDir, 'alpha.SKILL.md'), 'alpha')

    const loader = new SkillsLoader()
    loader.loadProjectSkills(root)
    expect(loader.list().map((s) => s.name)).toEqual(['alpha'])
  })

  it('读取域子目录（loop-scaffold 的 <domain>/<name>.SKILL.md 布局）', () => {
    const root = tmp()
    const domainDir = join(root, '.mipham', 'skills', 'code')
    mkdirSync(domainDir, { recursive: true })
    writeSkill(join(domainDir, 'beta.SKILL.md'), 'beta')

    const loader = new SkillsLoader()
    loader.loadProjectSkills(root)
    expect(loader.list().map((s) => s.name)).toEqual(['beta'])
  })

  it('目录不存在时不抛错、不加载任何东西', () => {
    const loader = new SkillsLoader()
    expect(() => loader.loadProjectSkills(tmp())).not.toThrow()
    expect(loader.list()).toHaveLength(0)
  })

  it('reload() 会重扫项目目录 —— 会话中新写的技能能被捡起', () => {
    const root = tmp()
    const skillsDir = join(root, '.mipham', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    const loader = new SkillsLoader()
    loader.loadProjectSkills(root)
    expect(loader.list()).toHaveLength(0)

    writeSkill(join(skillsDir, 'later.SKILL.md'), 'later')
    loader.reload()
    expect(loader.list().map((s) => s.name)).toEqual(['later'])
  })
})
