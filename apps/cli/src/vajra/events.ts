export type DispatchMode = 'emit' | 'waterfall' | 'parallel' | 'serial'

/**
 * 事件契约映射。每个事件名声明其派发模式；里程碑/测试通过
 * declaration merging 扩展本 interface（无需改内核）。
 */
export interface EventMap {}

/** 提取声明为指定 mode 的事件名联合。 */
export type EventsOfMode<M extends DispatchMode> = {
  [K in keyof EventMap]: EventMap[K] extends { mode: M } ? K : never
}[keyof EventMap]
