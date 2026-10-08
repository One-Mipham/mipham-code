import { describe, it, expect } from 'vitest'
import { join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { execSync } from 'node:child_process'
import {
  InstructionsLoader,
  stripSections,
  parsePromptExclude,
  gitRoot,
  discoverDirectories,
} from '../../src/core/instructions'

describe('InstructionsLoader.buildSystemPrompt', () => {
  it('injects the commit-attribution instruction (AI 署名披露)', () => {
    const prompt = new InstructionsLoader().buildSystemPrompt()
    expect(prompt).toContain('Commit Attribution')
    expect(prompt).toContain('Co-Authored-By: Mipham <noreply@mipham.ai>')
  })

  it('injects the greeting-restraint instruction (寒暄克制)', () => {
    const prompt = new InstructionsLoader().buildSystemPrompt()
    expect(prompt).toContain('Greeting Restraint')
    expect(prompt).toContain('Do NOT introduce yourself')
  })

  it('injects actionable permission-escalation guidance (连续被挡要止损并求助)', () => {
    const block = new InstructionsLoader().buildPermissionBlock('default')
    expect(block).toContain('STOP retrying')
    expect(block).toContain('bypassPermissions')
    expect(block).toContain('/permissions')
  })

  it('base prompt 不含权限段 —— 它由 ContextManager 读时派生，不是两处各存一份', () => {
    // 这条是「两份拷贝会分叉」的机械防线：谁把模式重新烘回 `buildSystemPrompt`，
    // 系统提示里就会同时出现烘死的旧段与派生的新段（互相矛盾），这里立刻红。
    const prompt = new InstructionsLoader().buildSystemPrompt()
    expect(prompt).not.toContain('## Permission Context')
    expect(prompt).not.toContain('STOP retrying')
  })

  it('先读代码铁律把 graft 说成 CLI，而不是并列在自家工具里', () => {
    // `graft` 不在工具注册表里（`src/tools/` 零命中；它是仓库被 graft 索引后
    // 通过 Bash 调的 CLI，或用户自配的 MCP 工具）。把它写进「Read, Grep, Glob, or
    // graft tools」会让模型去调一个不存在的工具名。
    // 幽灵名守卫那位**大写开头**的臂至今看不见它（`graft` 全小写，既不撞前缀也不以
    // 大写开头 —— 盲区是结构性的，不是漏配名单）；抓它的是 2026-09-29 补的**姊妹件**
    // 「枚举混进非工具」臂（`tool-reference-integrity.test.ts`），那一臂正是拿这句话
    // 当正对照钉住的。本断言留着，是因为它钉的是**这一句原文**，而那一臂钉的是**这一形状**。
    const prompt = new InstructionsLoader().buildSystemPrompt()
    expect(prompt).toContain('Read, Grep, or Glob tools')
    expect(prompt).toContain('a CLI you run through Bash')
    expect(prompt).not.toContain('Read, Grep, Glob, or graft tools')
  })
})

describe('stripSections (prompt-exclude)', () => {
  it('strips a section from its heading to the next same-level heading, keeping the rest', () => {
    const doc = `# Rules
- keep this
## Changelog
- drop this
## Architecture
- keep arch`
    const out = stripSections(doc, ['Changelog'])
    expect(out).toContain('keep this')
    expect(out).toContain('keep arch')
    expect(out).not.toContain('drop this')
  })

  it('strips subheadings along with an excluded ## section', () => {
    const doc = `## 下一步计划
### 修订历史
- version table
## Keep
- kept`
    const out = stripSections(doc, ['下一步计划'])
    expect(out).toContain('kept')
    expect(out).not.toContain('version table')
    expect(out).not.toContain('修订历史')
  })

  it('returns the document unchanged when excluded is empty', () => {
    const doc = '## A\n- x\n## B\n- y'
    expect(stripSections(doc, [])).toBe(doc)
  })
})

describe('parsePromptExclude', () => {
  it('normalizes a YAML list, a single string, and absent value', () => {
    expect(parsePromptExclude(['最近提交', '下一步计划'])).toEqual(['最近提交', '下一步计划'])
    expect(parsePromptExclude('修订历史')).toEqual(['修订历史'])
    expect(parsePromptExclude(undefined)).toEqual([])
  })
})

describe('gitRoot', () => {
  it('falls back to cwd outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-instr-'))
    try {
      expect(gitRoot(dir)).toBe(resolve(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 非 git 目录是**正常路径** —— `gitRoot` 自己 catch 掉并回退 cwd。所以 git 那句
  // `fatal: not a git repository` 不是要报的错，但它默认走继承的 stderr，会原样漏到
  // 终端上：从 home 目录启动（`~` 不是仓库）就能看见那两行。
  it('不把 git 的 stderr 漏到终端', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-instr-'))
    const leaked: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => {
      leaked.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      gitRoot(dir)
    } finally {
      process.stderr.write = orig
      rmSync(dir, { recursive: true, force: true })
    }
    expect(leaked.join('')).not.toContain('fatal')
  })

  // 正对照：上面那一格不能靠「本来就什么都读不到」变绿。修法是把 stdio 写成
  // `['ignore','pipe','pipe']` —— 若照抄 `commands.ts` 里那种 stdout 不用的 `'ignore'`，
  // stdout 不再是管道，`gitRoot` 会永远拿到空串、永远回退 cwd，**连在仓库里都失效**。
  it('正对照：仓库内的子目录仍解析出仓库根（stdout 必须仍是管道）', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-instr-repo-')))
    try {
      execSync('git init', { cwd: repo, stdio: 'ignore' })
      mkdirSync(join(repo, 'sub'), { recursive: true })
      expect(gitRoot(join(repo, 'sub'))).toBe(repo)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('discoverDirectories', () => {
  it('returns [root] when cwd equals root', () => {
    expect(discoverDirectories('/repo', '/repo')).toEqual([resolve('/repo')])
  })
  it('walks root → cwd, nearest last', () => {
    expect(discoverDirectories('/repo', '/repo/apps/cli')).toEqual([
      resolve('/repo'),
      resolve('/repo/apps'),
      resolve('/repo/apps/cli'),
    ])
  })
  it('degrades to [cwd] when cwd is outside root', () => {
    expect(discoverDirectories('/repo', '/other')).toEqual([resolve('/other')])
  })
})

describe('InstructionsLoader.loadAll (AGENTS.md 多格式 + 递归)', () => {
  it('loads AGENTS.md alongside CLAUDE.md and MIPHAM.md, AGENTS first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-instr-'))
    try {
      writeFileSync(join(dir, 'AGENTS.md'), '# AGENTS rules\n- agent rule')
      writeFileSync(join(dir, 'CLAUDE.md'), '# CLAUDE rules\n- claude rule')
      writeFileSync(join(dir, 'MIPHAM.md'), '# MIPHAM rules\n- mipham rule')
      const loader = new InstructionsLoader()
      loader.loadAll(dir)
      const files = loader.list().filter((f) => f.path.startsWith(dir))
      const names = files.map((f) => basename(f.path))
      expect(names).toContain('AGENTS.md')
      expect(names).toContain('CLAUDE.md')
      expect(names).toContain('MIPHAM.md')
      expect(names.indexOf('AGENTS.md')).toBeLessThan(names.indexOf('MIPHAM.md'))
      expect(names.indexOf('MIPHAM.md')).toBeLessThan(names.indexOf('CLAUDE.md'))
      expect(files.find((f) => basename(f.path) === 'AGENTS.md')!.level).toBe('project')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recursively loads subdirectory AGENTS.md as directory level', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-instr-')))
    try {
      execSync('git init -q', { cwd: root })
      writeFileSync(join(root, 'AGENTS.md'), '# root agents')
      mkdirSync(join(root, 'apps'))
      writeFileSync(join(root, 'apps', 'AGENTS.md'), '# apps agents')
      const loader = new InstructionsLoader()
      loader.loadAll(join(root, 'apps'))
      const list = loader.list()
      const rootAgents = list.find((f) => f.path === join(root, 'AGENTS.md'))
      const appsAgents = list.find((f) => f.path === join(root, 'apps', 'AGENTS.md'))
      expect(rootAgents!.level).toBe('directory')
      expect(appsAgents!.level).toBe('project')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('项目层指令不许是符号链接', () => {
  /**
   * 一个 clone 能把 `CLAUDE.md -> ~/.ssh/id_rsa` 带进来，而**这条加载链没有任何权限门**
   * —— 内容直接进系统提示，模型连问都不用问。所以被判的是**形状**（是不是普通文件），
   * 不是链接**指向哪里**：指向仓库内也一样拒，规则简单且 fail-closed。
   *
   * 下面每条都配了一个正对照。少了它，「零命中」与「加载器压根没跑」在断言上同形 ——
   * 而后者正是这个技能库里反复出现的假绿。
   */
  it('指向仓库外的软链不加载；同一目录里的普通文件照常加载', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-instr-link-')))
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-instr-secret-')))
    try {
      execSync('git init -q', { cwd: root })
      const secret = join(outside, 'id_rsa')
      writeFileSync(secret, 'PRIVATE-KEY-MATERIAL-abc123')
      symlinkSync(secret, join(root, 'CLAUDE.md'))
      writeFileSync(join(root, 'AGENTS.md'), '# AGENTS rules\n- real file')

      const loader = new InstructionsLoader()
      loader.loadAll(root)
      const list = loader.list()

      expect(
        list.some((f) => f.path === join(root, 'CLAUDE.md')),
        '软链的 CLAUDE.md 不该进指令清单',
      ).toBe(false)
      expect(loader.buildSystemPrompt(), '仓库外那个文件的内容一字都不该进系统提示').not.toContain(
        'PRIVATE-KEY-MATERIAL-abc123',
      )
      // 正对照：同目录的普通文件必须仍在。否则上面两条对「加载器整个坏了」也成立。
      expect(
        list.some((f) => f.path === join(root, 'AGENTS.md')),
        '普通文件必须照常加载 —— 否则这条测的是加载器坏了，不是软链被拦',
      ).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('指向仓库**内**的软链同样拒 —— 拦的是形状，不是目的地', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-instr-linkin-')))
    try {
      execSync('git init -q', { cwd: root })
      writeFileSync(join(root, 'REAL.md'), '# real rules\n- in-repo target')
      symlinkSync(join(root, 'REAL.md'), join(root, 'CLAUDE.md'))

      const loader = new InstructionsLoader()
      loader.loadAll(root)
      expect(loader.list().some((f) => f.path === join(root, 'CLAUDE.md'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('集团/公司层的软链**不**被拦 —— 拦的只是仓库自己塞得进来的那两层', () => {
    // 这条钉的是**范围**，不是效果：把闸门扩到 `../CLAUDE.md`（公司层）会打断
    // 「dotfiles 仓库里放一份共用的 CLAUDE.md 再链过来」这种完全正当的布置，
    // 而那个位置本来就不由被 clone 的这个仓库控制。
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-instr-co-')))
    const root = join(base, 'repo')
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-instr-cotarget-')))
    try {
      writeFileSync(join(outside, 'shared.md'), '# company rules\n- COMPANY-LINK-CONTENT')
      symlinkSync(join(outside, 'shared.md'), join(base, 'CLAUDE.md'))
      mkdirSync(root)
      execSync('git init -q', { cwd: root })

      const loader = new InstructionsLoader()
      loader.loadAll(root)
      const company = loader.list().find((f) => f.level === 'company')
      expect(company, '公司层软链应当照常加载').toBeDefined()
      expect(loader.buildSystemPrompt()).toContain('COMPANY-LINK-CONTENT')
    } finally {
      rmSync(base, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

// ============================================================
// `loadForPaths` —— 基线链只走一次（git 根 → cwd），比 cwd 更深的文件、
// 或旁支目录里的文件，启动时一条规则都带不上，尽管它旁边那份 CLAUDE.md 正是
// 管着它的那套规则。这里钉的是「看过哪里的文件，就补上那里的规则」，
// 并且**按路径而不是按工具**——Bash 的 `cat`/`sed -n`/`grep` 与 Read 走同一条。
// ============================================================

describe('InstructionsLoader.loadForPaths（补上没在基线链里的目录规则）', () => {
  function makeRepo(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-instr-paths-')))
    execSync('git init -q', { cwd: root })
    mkdirSync(join(root, 'apps', 'cli'), { recursive: true })
    mkdirSync(join(root, 'services', 'billing'), { recursive: true })
    writeFileSync(join(root, 'CLAUDE.md'), '# root rules\n- ROOT-RULE')
    writeFileSync(join(root, 'apps', 'cli', 'CLAUDE.md'), '# cli rules\n- CLI-RULE')
    writeFileSync(join(root, 'services', 'CLAUDE.md'), '# services rules\n- SERVICES-RULE')
    writeFileSync(join(root, 'services', 'billing', 'CLAUDE.md'), '# billing rules\n- BILLING-RULE')
    writeFileSync(join(root, 'services', 'billing', 'invoice.ts'), 'export const x = 1')
    return root
  }

  it('旁支目录：启动时一个字都没读，碰到它的文件时补上（且沿途每一层都补）', () => {
    const root = makeRepo()
    try {
      const cwd = join(root, 'apps', 'cli')
      const loader = new InstructionsLoader()
      loader.loadAll(cwd)

      // 负控：基线链是 git 根 → apps → apps/cli，`services/` 不在其上。
      // 少了这一句，「补上」与「本来就在」在断言上同形。
      expect(loader.buildSystemPrompt()).not.toContain('BILLING-RULE')
      expect(loader.buildSystemPrompt()).not.toContain('SERVICES-RULE')

      const block = loader.loadForPaths([join(root, 'services', 'billing', 'invoice.ts')], cwd)
      expect(block).toContain('BILLING-RULE')
      // 中途那一层也要带上 —— 只补文件所在的那一层是不够的，规则是从仓库根往下叠的。
      expect(block).toContain('SERVICES-RULE')
      // 已经加载过的层不重复注入（ROOT-RULE 在基线里已有）。
      expect(block).not.toContain('ROOT-RULE')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('同一个目录再看一次就不再补（返回 null ⇒ 调用方整段不注入）', () => {
    const root = makeRepo()
    try {
      const cwd = join(root, 'apps', 'cli')
      const loader = new InstructionsLoader()
      loader.loadAll(cwd)
      const file = join(root, 'services', 'billing', 'invoice.ts')

      expect(loader.loadForPaths([file], cwd)).toContain('BILLING-RULE')
      // 第二轮：软性 null，不是空串 —— 空串会被注入成一个空壳段落。
      expect(loader.loadForPaths([file], cwd)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('仓库外的一律不带入 —— 判据是「在检出内」，不是「文件存在」', () => {
    const root = makeRepo()
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-instr-outside-')))
    try {
      writeFileSync(join(outside, 'CLAUDE.md'), '# not ours\n- OUTSIDE-RULE')
      writeFileSync(join(outside, 'secret.ts'), 'x')
      const cwd = join(root, 'apps', 'cli')
      const loader = new InstructionsLoader()
      loader.loadAll(cwd)

      expect(loader.loadForPaths([join(outside, 'secret.ts')], cwd)).toBeNull()

      // 正对照：同一批调用里换一个仓库内的路径，立刻就补上了 —— 否则上面那条
      // 对「loadForPaths 整个是坏的」也成立。
      expect(loader.loadForPaths([join(root, 'services', 'billing', 'invoice.ts')], cwd)).toContain(
        'BILLING-RULE',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('给的是目录本身（Grep/Glob 的搜索根）时同样成立', () => {
    const root = makeRepo()
    try {
      const cwd = join(root, 'apps', 'cli')
      const loader = new InstructionsLoader()
      loader.loadAll(cwd)

      const block = loader.loadForPaths([join(root, 'services', 'billing')], cwd)
      expect(block).toContain('BILLING-RULE')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('还不存在的路径（Write 新文件）按文件读 —— 补的是它所在目录那一层', () => {
    const root = makeRepo()
    try {
      const cwd = join(root, 'apps', 'cli')
      const loader = new InstructionsLoader()
      loader.loadAll(cwd)

      const block = loader.loadForPaths([join(root, 'services', 'billing', 'brand-new.ts')], cwd)
      expect(block).toContain('BILLING-RULE')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
