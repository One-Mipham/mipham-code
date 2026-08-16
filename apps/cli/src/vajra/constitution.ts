/**
 * 对齐缝 capability —— 内核在 Service 挂载前调用，校验其声明的对齐原则。
 *
 * 「金刚不坏」从隐喻变成 `mount()` 的强制前置条件：Service 可选声明 `align`
 * （遵守的宪法原则 id），内核在 apply 前向 `constitution` 缝求证，声明的 id
 * 必须全部已知，否则拒绝挂载。此接口只定义「求证」契约，不绑定任何具体宪法来源。
 */
export interface Constitution {
  /** 校验声明的原则 id；返回违规 id 列表（空 = 通过）。 */
  check(aligned: string[]): { violations: string[] }
}

/** 缝键：ctx.constitution。 */
export const CONSTITUTION_KEY = 'constitution'
