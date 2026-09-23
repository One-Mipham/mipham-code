import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Ctrl+C 的「再按一次才退出」窗口。
 *
 * 为什么需要它：Ink 默认的 Ctrl+C 语义是**立刻退出**，而 TUI 里 Ctrl+C 的合
 * 理语义是「停下手上这件事」—— 对话框开着、回合跑着的时候，误按一次不该把
 * 整个会话带走。所以 `render()` 处一律传 `exitOnCtrlC: false`（见
 * `src/index.tsx`），退出的决定权收回到这里：第一次按只「上膛」，窗口内再按
 * 一次才真退。
 *
 * 两个入口（主界面 `ui/app.tsx`、看板 `agent-view/dashboard.tsx`）共用这一份，
 * 而不是各写一遍 —— 同一条语义有两份实现，迟早会长成两个东西。
 *
 * 注意 `isArmed()` 与 `armed` 是**两条路**，不是冗余：
 * - 判据要走 `isArmed()`（ref）—— 在同一个按键回调里 `arm()` 之后 state 还没
 *   重渲染，用 state 读的话第二次按键看到的仍是 false，就永远退不出去；
 * - `armed`（state）只给渲染用（页脚那句提示）。
 */
export interface CtrlCConfirm {
  /** 渲染用：当前是否处于「待确认」窗口内。 */
  armed: boolean
  /** 判据用：同步读数，同一次按键回调里 `arm()` 之后立刻为 true。 */
  isArmed: () => boolean
  /** 上膛：进入待确认窗口，`windowMs` 后自动撤。 */
  arm: () => void
  /** 撤膛：关掉窗口并清掉计时器（例如这次按键被别的事情消费掉了）。 */
  reset: () => void
}

export function useCtrlCConfirm(windowMs = 2000): CtrlCConfirm {
  const armedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [armed, setArmed] = useState(false)

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const reset = useCallback(() => {
    clear()
    armedRef.current = false
    setArmed(false)
  }, [clear])

  const arm = useCallback(() => {
    clear()
    armedRef.current = true
    setArmed(true)
    timerRef.current = setTimeout(() => {
      armedRef.current = false
      setArmed(false)
    }, windowMs)
  }, [clear, windowMs])

  // 卸载时撤掉计时器 —— 否则它到点后会往已经卸掉的组件里 setState。
  useEffect(() => clear, [clear])

  const isArmed = useCallback(() => armedRef.current, [])

  return { armed, isArmed, arm, reset }
}
