/**
 * 输入诊断开关：`MIPHAM_DEBUG_INPUT=1`。
 *
 * 「窗口冻结」从进程外看只有一种样子：进程活着、主线程停在 `kevent`、终端还留在
 * raw 模式、按键没有反应。但它至少是两种完全不同的故障：
 *
 *   A. 按键**没有送达应用**（stdin 侧：监听被摘掉、流被暂停、子进程抢了 tty）
 *   B. 按键送达了，但**没有组件处理或没有渲染**（React 侧：树被替换、handler 早退）
 *
 * 两者的补救方向相反，而进程外无法区分。所以这里在「应用看见每个按键的那一刻」
 * 与「每次提交渲染」各记一笔，按秒汇总成一行写进 `~/.mipham/input-debug.log`：
 *
 *   有 keys、有 renders   → 应用在处理（问题在输出/终端侧）
 *   有 keys、无 renders   → 渲染死了（B）
 *   一个 key 都没有       → 输入没送达（A）
 *
 * 只记**计数与按键类别**，不记文本内容（与遥测的 no-free-text 约束一致）。
 * 默认关闭；关闭时每条路径只是一次缓存过的布尔判断，不产生任何 I/O。
 */

import { statSync, truncateSync } from 'node:fs'
import { miphamHome } from '../core/paths.ts'
import { appendRegularFileSync, isRegularFile } from '../shared/regular-file.ts'

/** 超过这个大小就在启动时截断：诊断日志不该成为磁盘问题。 */
const MAX_BYTES = 2 * 1024 * 1024
/** 汇总行间隔。1s 足够区分「冻结后还有没有活动」。 */
export const FLUSH_INTERVAL_MS = 1000

/** 只取本模块关心的字段，避免把 Ink 的 Key 类型搬进来。 */
export interface DebugKeyShape {
  ctrl?: boolean
  shift?: boolean
  escape?: boolean
  return?: boolean
  tab?: boolean
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  backspace?: boolean
  delete?: boolean
}

export interface InputDebugOptions {
  /** 写入的文件；默认 `~/.mipham/input-debug.log`。 */
  filePath?: string
  /** 测试注入。 */
  now?: () => number
  pid?: number
}

export interface InputDebug {
  recordKey(input: string, key: DebugKeyShape): void
  recordRender(): void
  /** 把当前窗口的计数写成一行（无新事件时不写）。 */
  flush(): void
  dispose(): void
}

/** 按键的人类可读类别 —— 只有类别，没有文本内容。 */
export function describeKey(input: string, key: DebugKeyShape): string {
  if (key.ctrl) return `ctrl:${input || '?'}`
  if (key.escape) return 'escape'
  if (key.return) return 'return'
  if (key.tab) return 'tab'
  if (key.upArrow) return 'up'
  if (key.downArrow) return 'down'
  if (key.leftArrow) return 'left'
  if (key.rightArrow) return 'right'
  if (key.backspace) return 'backspace'
  if (key.delete) return 'delete'
  // 整串都可打印才叫文本；混进控制字符（ESC 序列等）就只报长度，
  // 避免把终端逃逸序列原样写进日志。
  const allPrintable = /^[\x20-\x7e\u0080-￿]+$/.test(input)
  return `${allPrintable ? 'text' : 'raw'}:${input.length}`
}

export function createInputDebug(opts: InputDebugOptions = {}): InputDebug {
  const filePath = opts.filePath ?? miphamHome('input-debug.log')
  const now = opts.now ?? Date.now
  const pid = opts.pid ?? process.pid

  let keys = 0
  let renders = 0
  let bytes = 0
  let last = 'none'
  let dirty = false

  // 启动标记：一个文件里能分出「这是哪一次进程、从哪一刻开始」。
  try {
    // 只在**普通文件**上截断：`truncateSync` 同样会打开目标，撞上 FIFO 就挂住
    // （见 shared/regular-file.ts 的来由）。
    if (isRegularFile(filePath) && statSync(filePath).size > MAX_BYTES) truncateSync(filePath, 0)
    const wrote = appendRegularFileSync(
      filePath,
      `--- start pid=${pid} at=${new Date(now()).toISOString()} ---\n`,
    )
    if (!wrote) throw new Error('not a regular file')
  } catch {
    // 写不了诊断日志不是运行时错误：静默降级为「不诊断」。
    return {
      recordKey() {},
      recordRender() {},
      flush() {},
      dispose() {},
    }
  }

  return {
    recordKey(input: string, key: DebugKeyShape): void {
      keys += 1
      bytes += input.length
      last = describeKey(input, key)
      dirty = true
    },
    recordRender(): void {
      renders += 1
      dirty = true
    },
    flush(): void {
      if (!dirty) return
      dirty = false
      const line =
        `${new Date(now()).toISOString()} pid=${pid} ` +
        `keys=${keys} renders=${renders} bytes=${bytes} last=${last}\n`
      try {
        appendRegularFileSync(filePath, line)
      } catch {
        /* 同上：诊断失败不影响主流程 */
      }
      keys = 0
      renders = 0
      bytes = 0
    },
    dispose(): void {
      this.flush()
    },
  }
}

// ── 进程级单例（接线点用；关闭时缓存的 null 让每次调用只是一次比较） ──

let singleton: InputDebug | null | undefined

export function getInputDebug(): InputDebug | null {
  if (singleton !== undefined) return singleton
  if (process.env.MIPHAM_DEBUG_INPUT !== '1') {
    singleton = null
    return null
  }
  singleton = createInputDebug()
  const timer = setInterval(() => singleton?.flush(), FLUSH_INTERVAL_MS)
  timer.unref?.()
  return singleton
}

export function recordKeyEvent(input: string, key: DebugKeyShape): void {
  getInputDebug()?.recordKey(input, key)
}

export function recordRenderCommit(): void {
  getInputDebug()?.recordRender()
}
