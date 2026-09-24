import { useCallback, useRef, useState } from 'react'

/**
 * 一个状态 + 一个「在同一次按键回调里也读得到最新值」的镜像。
 *
 * 为什么需要它：一组按键会在同一个 chunk 里到达（远端/远程控制，或键盘把
 * 「↓ 然后 Enter」一起写进来），Ink 的输入解析器会把这种转义序列打头的 chunk
 * 切开**逐个派发** —— 而 React 还没提交第一个回调里的 setState，第二个回调拿到的
 * 就还是上一张闭包。于是「↓ Enter」按在**按下 ↓ 之前**那一行上：按键有反应，
 * 世界却是上一拍的。
 *
 * 与 `useCtrlCConfirm` 的两条路同源（那里的 `isArmed()` / `armed`）：
 * - `value` 只给渲染用；
 * - `read()` 给判据用 —— 同步读数，同一次按键回调里 `set()` 之后立刻为新值；
 * - `set()` 接受函数式写法，并按 `read()` 的当前值求值，于是同一个 burst 里的多次
 *   修改能**叠加**（两次 ↓ 是两步，而不是把两次都算在同一个起点上）。
 *
 * 注意 `set()` 之外不要再写这个 state —— 绕过它写会让镜像与真值分叉。
 */
export interface KeyState<T> {
  /** 渲染用。 */
  value: T
  /**
   * 写入。函数式写法按 `read()` 求值后落盘：同一个 burst 里调用多次会依次叠加。
   *
   * `T` 是函数时函数式写法不可用（按值处理）—— 本仓库的调用点都是索引/枚举。
   */
  set: (next: T | ((prev: T) => T)) => void
  /** 判据用：同步读数，`set()` 之后立刻为新值。 */
  read: () => T
}

export function useKeyState<T>(initial: T | (() => T)): KeyState<T> {
  const [value, setValue] = useState(initial)
  const ref = useRef(value)

  const set = useCallback((next: T | ((prev: T) => T)) => {
    const resolved = typeof next === 'function' ? (next as (prev: T) => T)(ref.current) : next
    ref.current = resolved
    setValue(resolved)
  }, [])

  const read = useCallback(() => ref.current, [])

  // 返回的对象**身份稳定**（每次渲染只刷新 `.value`）：调用点会把它整个放进依赖
  // 数组，每次渲染换一个身份会让依赖它的 effect 每次都重跑。
  const apiRef = useRef<KeyState<T> | null>(null)
  let api = apiRef.current
  if (!api) {
    api = { value, set, read }
    apiRef.current = api
  }
  api.value = value
  return api
}
