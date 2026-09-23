/**
 * 状态文件的**读侧形状闸** —— 「合法 JSON 不等于合法形状」。
 *
 * 从前这几条链上只查「文件在不在」和「`JSON.parse` 成不成功」，于是下面每一个 fixture
 * 都过得了闸、然后在下游某个解引用处炸掉（实测：`index.length`、`name.replace`、
 * `metadata.name`、`msg.role`、`content.filter` 五处 TypeError，全在启动 / `/resume`
 * 那条链上，没有一处在 try 里）。坏形状**不是凭空来的**：非原子写的半截文件、手改、
 * 版本回退都会产出它。
 *
 * 反向也要钉住（否则「一律返回 null」也能全绿）：每条闸门都配一条**合法输入**的用例，
 * 证明闸门放行的是它该放行的东西。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// 与 session-store.test.ts / journal.test.ts 同一套隔离：homedir 指向 tmp，
// 绝不碰开发者真实的 ~/.mipham。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-state-shape`,
  }
})

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { SessionStore } from '../../src/core/session-store'
import { SessionLog, deriveMessages, isValidMessage } from '../../src/core/session-log'
import { appendJournal, loadJournal } from '../../src/workflow/journal'

const HOME = homedir()
const SESSIONS_DIR = join(HOME, '.mipham', 'sessions')
const INDEX_FILE = join(SESSIONS_DIR, '.index.json')
const WORKFLOW_DIR = join(HOME, '.mipham', 'workflows')
const RUN_ID = 'test-shape-run'
const RUN_DIR = join(WORKFLOW_DIR, RUN_ID)

/** 把内容写进某个会话的 `.jsonl`（读侧一律从磁盘开始，不经过任何写路径）。 */
function plantSession(name: string, raw: string): string {
  mkdirSync(SESSIONS_DIR, { recursive: true })
  const path = join(SESSIONS_DIR, `${name}.jsonl`)
  writeFileSync(path, raw, 'utf-8')
  return path
}

beforeEach(() => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true })
  rmSync(RUN_DIR, { recursive: true, force: true })
  mkdirSync(SESSIONS_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true })
  rmSync(RUN_DIR, { recursive: true, force: true })
})

describe('isValidMessage', () => {
  it('放行字符串 content 与块数组', () => {
    expect(isValidMessage({ role: 'user', content: 'hi' })).toBe(true)
    expect(isValidMessage({ role: 'assistant', content: [{ type: 'text', text: 'x' }] })).toBe(true)
  })

  it('拦下解析得出、但形状不足的消息', () => {
    // `{}` 从前是放行的：投影照收，provider 侧 `m.content.filter` 当场 TypeError。
    expect(isValidMessage({})).toBe(false)
    expect(isValidMessage({ role: 'user' })).toBe(false)
    expect(isValidMessage({ role: 'user', content: null })).toBe(false)
    expect(isValidMessage({ role: 'narrator', content: 'x' })).toBe(false)
    expect(isValidMessage({ role: 'user', content: [null] })).toBe(false)
    expect(isValidMessage(null)).toBe(false)
  })
})

describe('SessionLog.open —— 事件形状闸', () => {
  const good = { type: 'user/message', at: 1, message: { role: 'user', content: 'hi' } }

  it('坏行丢掉、邻行全留（半截文件不该赔上整份历史）', () => {
    const path = plantSession(
      'test-shape-mixed',
      [JSON.stringify(good), '{"type":"user/message","message":{}}', '{半截'].join('\n') + '\n',
    )
    const log = SessionLog.open('test-shape-mixed')
    expect(log.events()).toHaveLength(1)
    expect(log.events()[0]).toEqual(good)
    expect(path).toBeTruthy()
  })

  it('compaction/rewrite 的元素与 message 事件同罪', () => {
    plantSession(
      'test-shape-rewrite',
      JSON.stringify({ type: 'compaction/rewrite', at: 1, messages: [null] }) + '\n',
    )
    expect(SessionLog.open('test-shape-rewrite').events()).toHaveLength(0)
  })

  it('合法输入照常读回（反向控制：闸门没有把所有东西都拦掉）', () => {
    const events = [good, { type: 'assistant/chunk', at: 2, chunk: 'a' }]
    plantSession('test-shape-good', events.map((e) => JSON.stringify(e)).join('\n') + '\n')
    const log = SessionLog.open('test-shape-good')
    expect(log.events()).toHaveLength(2)
    expect(deriveMessages(log.events())).toEqual([{ role: 'user', content: 'hi' }])
  })
})

describe('SessionStore.load —— 快照形状闸', () => {
  it('metadata 为 null 不再抛出（`getName` 由调用方读 metadata.name）', () => {
    plantSession('test-shape-meta-null', JSON.stringify({ metadata: null, messages: [] }))
    expect(() => SessionStore.load('test-shape-meta-null')).not.toThrow()
    expect(SessionStore.load('test-shape-meta-null')).toBeNull()
  })

  it('messages 里的 null 元素不再流到 UI 的 msg.role', () => {
    const raw = JSON.stringify({
      metadata: { name: 'test-shape-msg-null', createdAt: '', updatedAt: '' },
      messages: [null],
    })
    plantSession('test-shape-msg-null', raw)
    expect(SessionStore.load('test-shape-msg-null')).toBeNull()
  })

  it('合法的旧格式快照照常读回（反向控制）', () => {
    const session = {
      metadata: {
        name: 'test-shape-ok',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        provider: 'p',
        model: 'm',
        messageCount: 1,
      },
      messages: [{ role: 'user', content: 'hi' }],
    }
    plantSession('test-shape-ok', JSON.stringify(session))
    expect(SessionStore.load('test-shape-ok')?.messages).toEqual(session.messages)
  })
})

describe('SessionStore 索引闸', () => {
  it.each([
    ['null', 'null'],
    ['对象', '{"a":1}'],
    ['数字数组', '[1,2]'],
    ['缺 name 的条目', '[{"createdAt":"x"}]'],
    ['空 name 的条目', '[{"name":""}]'],
  ])('%s 不抛，且 getLatest 视为无会话', (_label, raw) => {
    writeFileSync(INDEX_FILE, raw, 'utf-8')
    expect(() => SessionStore.getLatest()).not.toThrow()
    expect(SessionStore.getLatest()).toBeNull()
  })

  it('合法索引照常返回（反向控制）', () => {
    writeFileSync(
      INDEX_FILE,
      JSON.stringify([
        {
          name: 'test-shape-index-ok',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          provider: 'p',
          model: 'm',
          messageCount: 1,
          tokenCount: 0,
        },
      ]),
      'utf-8',
    )
    expect(SessionStore.getLatest()?.name).toBe('test-shape-index-ok')
  })
})

describe('workflow journal 的读写闸', () => {
  const line = (seq: number): string =>
    JSON.stringify({ seq, type: 'log', message: `m${seq}` }) + '\n'

  it('state.json 是半截 JSON 时，seq 从 journal 尾行推出来（不是归零）', () => {
    mkdirSync(RUN_DIR, { recursive: true })
    writeFileSync(join(RUN_DIR, 'journal.jsonl'), line(1) + line(2), 'utf-8')
    writeFileSync(join(RUN_DIR, 'state.json'), '{"seq": 2', 'utf-8')
    expect(appendJournal(RUN_ID, { type: 'log', message: 'next' })).toBe(3)
    // 归零会复用已经在用的序号 —— 那正是这份文件存在的意义。
    expect(appendJournal(RUN_ID, { type: 'log', message: 'next2' })).toBe(4)
  })

  it('journal.jsonl 尾部半截行只丢那一行', () => {
    mkdirSync(RUN_DIR, { recursive: true })
    writeFileSync(join(RUN_DIR, 'journal.jsonl'), line(1) + '{"seq":2,"type":"lo', 'utf-8')
    expect(loadJournal(RUN_ID).map((e) => e.seq)).toEqual([1])
  })

  it('完好的 journal 全量读回（反向控制）', () => {
    mkdirSync(RUN_DIR, { recursive: true })
    writeFileSync(join(RUN_DIR, 'journal.jsonl'), line(1) + line(2), 'utf-8')
    expect(loadJournal(RUN_ID).map((e) => e.seq)).toEqual([1, 2])
  })
})
