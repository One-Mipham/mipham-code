import { describe, it, expect, vi, beforeEach } from 'vitest'

// Isolate the preference store from the real ~/.mipham — setPreference() persists
// to preferences.json, so tests must not pollute the user's live file.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-preferences`,
  }
})

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getPreference, setPreference } from '../../src/config/preferences.js'

const TEST_HOME = join(tmpdir(), 'mipham-test-preferences')
const PREFS_DIR = join(TEST_HOME, '.mipham')
const PREFS_FILE = join(PREFS_DIR, 'preferences.json')

beforeEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('preferences', () => {
  it('returns the default when nothing is stored', () => {
    expect(getPreference('codeReviewEffort', 'medium')).toBe('medium')
  })

  it('round-trips a value', () => {
    setPreference('codeReviewEffort', 'high')
    expect(getPreference('codeReviewEffort', 'medium')).toBe('high')
  })

  it('keeps other keys when setting one', () => {
    setPreference('a', '1')
    setPreference('b', '2')
    expect(getPreference('a', '')).toBe('1')
    expect(getPreference('b', '')).toBe('2')
  })

  it('文件不可解析时读成默认值（所以写坏它 = 静默丢掉全部偏好）', () => {
    setPreference('seed', 'x') // 先把目录建出来
    // 半截 JSON —— 非原子写崩在写中途就是这个形态。
    writeFileSync(PREFS_FILE, '{"codeReviewEffort": "hi', 'utf-8')

    expect(getPreference('codeReviewEffort', 'medium')).toBe('medium')
    expect(getPreference('seed', 'gone')).toBe('gone')
  })

  // preferences.json 原先走裸 writeFileSync：写到一半被打断就留下一份不可解析的
  // 文件，而读路径把不可解析吞成「空」（readPrefs 的 catch）⇒ 全部偏好静默消失。
  it('写入是原子的，权限 0o600，且不留临时文件', () => {
    setPreference('codeReviewEffort', 'high')

    expect(existsSync(PREFS_FILE)).toBe(true) // 正控：文件确实写出来了
    expect(JSON.parse(readFileSync(PREFS_FILE, 'utf-8'))).toMatchObject({
      codeReviewEffort: 'high',
    })
    expect(statSync(PREFS_FILE).mode & 0o777).toBe(0o600)
    expect(readdirSync(PREFS_DIR).filter((f) => f.includes('.tmp'))).toEqual([])

    // 「原子」的**直接**证据：原地截断重写会保持同一个 inode，先写临时文件再
    // rename 才会换 inode。权限与 tmp 残骸都证明不了这一点（裸 writeFileSync 加个
    // mode: 0o600 就能同时满足前两条）。
    const before = statSync(PREFS_FILE).ino
    setPreference('codeReviewEffort', 'low')
    expect(getPreference('codeReviewEffort', 'high')).toBe('low') // 正控：内容真的改了
    expect(statSync(PREFS_FILE).ino).not.toBe(before)
  })
})
