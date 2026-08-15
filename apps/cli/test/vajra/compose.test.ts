import { it, expect } from 'vitest'
import { assemble, dumpConfig, loadBundle, loadProfile } from '../../src/vajra/compose'
import type { Bundle, BundleLine, Profile } from '../../src/vajra/compose'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '../../src/vajra'
import { LLM_KEY } from '../../src/providers/llm'
import { replayLlm, type RecordedTurn } from '../../src/providers/llm-replay'
import {
  planRunnerService,
  PLAN_RUNNER_KEY,
  type PlanRunner,
} from '../../src/vajra/leaf/plan-runner'
import { mountLines, mountProfile, type ServiceResolver } from '../../src/vajra/compose'

it('assemble concatenates bundles in order', () => {
  const b1: Bundle = { name: 'b1', lines: [{ id: 't1', kind: 'tool', config: {} }] }
  const b2: Bundle = { name: 'b2', lines: [{ id: 'p1', kind: 'provider', config: {} }] }
  const profile: Profile = { name: 'p', bundles: ['b1', 'b2'] }
  const resolve = (n: string) => (n === 'b1' ? b1 : b2)
  expect(assemble(profile, resolve).map((l) => l.id)).toEqual(['t1', 'p1'])
})

it('dumpConfig prints one line per resolved line', () => {
  const lines: BundleLine[] = [{ id: 't1', kind: 'tool', config: { a: 1 } }]
  expect(dumpConfig(lines)).toContain('t1')
  expect(dumpConfig(lines)).toContain('tool')
})

it('loadBundle parses a yaml bundle file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm3-bundle-'))
  const p = join(dir, 'b.yml')
  writeFileSync(p, 'name: b\nlines:\n  - id: t1\n    kind: tool\n    config: {}\n')
  const b = loadBundle(p)
  expect(b.name).toBe('b')
  expect(b.lines[0]!.id).toBe('t1')
  rmSync(dir, { recursive: true, force: true })
})

it('loadProfile parses a yaml profile file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm3-profile-'))
  const p = join(dir, 'p.yml')
  writeFileSync(p, 'name: p\nbundles:\n  - b1\n  - b2\n')
  const profile = loadProfile(p)
  expect(profile.name).toBe('p')
  expect(profile.bundles).toEqual(['b1', 'b2'])
  rmSync(dir, { recursive: true, force: true })
})

it('loadBundle throws on non-array lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bad-bundle-'))
  const p = join(dir, 'bad.yml')
  writeFileSync(p, 'name: b\nlines: not-an-array\n')
  expect(() => loadBundle(p)).toThrow(/lines/)
  rmSync(dir, { recursive: true, force: true })
})

it('loadProfile throws on non-array bundles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bad-profile-'))
  const p = join(dir, 'bad.yml')
  writeFileSync(p, 'name: p\nbundles: not-an-array\n')
  expect(() => loadProfile(p)).toThrow(/bundles/)
  rmSync(dir, { recursive: true, force: true })
})

it('patch replaces a line by id', () => {
  const b1: Bundle = {
    name: 'b1',
    lines: [{ id: 'ver', kind: 'skill', config: { version: '1.0.0' } }],
  }
  const profile: Profile = {
    name: 'p',
    bundles: ['b1'],
    patch: { ver: { config: { version: '2.0.0' } } },
  }
  const lines = assemble(profile, () => b1)
  expect(lines.find((l) => l.id === 'ver')!.config.version).toBe('2.0.0')
})

it('package/version change lives in one bundle line via patch', () => {
  const b: Bundle = {
    name: 'meta',
    lines: [{ id: 'package-info', kind: 'provider', config: { version: '1.0.0' } }],
  }
  const profile: Profile = {
    name: 'p',
    bundles: ['meta'],
    patch: { 'package-info': { config: { version: '2.0.0' } } },
  }
  const dumped = dumpConfig(assemble(profile, () => b))
  expect(dumped).toContain('2.0.0')
  expect(dumped).not.toContain('1.0.0') // 旧版本不再出现 → 单源
  expect(dumped.split('\n').filter((l) => l.includes('package-info'))).toHaveLength(1) // 恰好一行
})

it('patch does not mutate the shared bundle line (per-profile isolation)', () => {
  const b: Bundle = {
    name: 'b',
    lines: [{ id: 'ver', kind: 'skill', config: { version: '1.0.0' } }],
  }
  const p1: Profile = {
    name: 'p1',
    bundles: ['b'],
    patch: { ver: { config: { version: '2.0.0' } } },
  }
  const p2: Profile = { name: 'p2', bundles: ['b'] }
  assemble(p1, () => b) // p1 打补丁到 2.0.0
  const lines2 = assemble(p2, () => b) // p2 共享同一 bundle，无补丁
  expect(lines2.find((l) => l.id === 'ver')!.config.version).toBe('1.0.0') // 未被 p1 污染
})

const text = (s: string): RecordedTurn => ({
  req: { model: 'm', messages: [] },
  chunks: [{ type: 'text', content: s }, { type: 'stop' }],
})

it('mounts the plan-runner leaf via a profile bundle', async () => {
  const ctx = new Context()
  ctx.provide(LLM_KEY, replayLlm([text('implemented A'), text('APPROVE')]))

  const bundle: Bundle = {
    name: 'orchestration',
    lines: [{ id: 'plan-runner', kind: 'service', config: {} }],
  }
  const resolveService: ServiceResolver = (line) =>
    line.id === 'plan-runner' ? planRunnerService : undefined

  const mounted = mountProfile(
    ctx,
    { name: 'default', bundles: ['orchestration'] },
    () => bundle,
    resolveService,
  )
  const runner = ctx.get<PlanRunner>(PLAN_RUNNER_KEY)!
  const outcomes = await runner.run({ name: 'p', tasks: [{ id: 't1', description: 'do A' }] })

  expect(outcomes.map((o) => o.status)).toEqual(['done'])
  expect(mounted).toHaveLength(1)
  expect(mounted[0]!.status()).toBe('active')
})

it('loads a bundle + profile from disk and mounts plan-runner (declarative end-to-end)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'leaf-mount-'))
  writeFileSync(
    join(dir, 'orchestration.yml'),
    'name: orchestration\nlines:\n  - id: plan-runner\n    kind: service\n    config: {}\n',
  )
  writeFileSync(join(dir, 'default.yml'), 'name: default\nbundles:\n  - orchestration\n')

  const ctx = new Context()
  ctx.provide(LLM_KEY, replayLlm([text('implemented'), text('APPROVE')]))

  const profile = loadProfile(join(dir, 'default.yml'))
  const resolveBundle = (name: string) => loadBundle(join(dir, `${name}.yml`))
  const resolveService: ServiceResolver = (line) =>
    line.id === 'plan-runner' ? planRunnerService : undefined

  const mounted = mountProfile(ctx, profile, resolveBundle, resolveService)
  const runner = ctx.get<PlanRunner>(PLAN_RUNNER_KEY)!
  const outcomes = await runner.run({ name: 'p', tasks: [{ id: 't1', description: 'do A' }] })

  expect(outcomes.map((o) => o.status)).toEqual(['done'])
  expect(mounted).toHaveLength(1)
  rmSync(dir, { recursive: true, force: true })
})

it('mountLines skips lines the resolver maps to undefined (data-only lines)', () => {
  const ctx = new Context()
  ctx.provide(LLM_KEY, replayLlm([]))

  const lines: BundleLine[] = [
    { id: 'package-info', kind: 'provider', config: { version: '1.0.0' } }, // 纯数据行，resolver 返回 undefined → 跳过
    { id: 'plan-runner', kind: 'service', config: {} },
  ]
  const resolveService: ServiceResolver = (line) =>
    line.id === 'plan-runner' ? planRunnerService : undefined

  const mounted = mountLines(ctx, lines, resolveService)

  expect(mounted).toHaveLength(1)
  expect(ctx.get(PLAN_RUNNER_KEY)).toBeDefined()
  expect(ctx.get('package-info')).toBeUndefined()
})
