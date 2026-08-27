/**
 * 判「可恢复/环境性」失败 vs 真缺陷（borrow openprabs is_recoverable_tool_failure 思想）。
 *
 * 可恢复失败（网络超时、连接拒绝、DNS 解析失败、环境权限）不该进成功率分母，否则会把
 * 成功率拉低、诱导 EffectivenessTracker 禁用能用的规则（openprabs #236 的坑：stale-hash
 * 重试被误判成工具缺陷，把能用的 hashline_edit 禁了）。
 *
 * 刻意排除 ENOENT（no such file or directory）：缺文件/路径错更可能是规则本身指错了
 * 路径（幻觉），而非环境瞬态，须计入分母（2026-08-27 review M1）。
 *
 * 不区分工具：这些错误模式（超时/连接/DNS/权限）本身即工具无关的环境信号。旧的
 * `toolName !== 'Bash'` 守卫漏掉 Write/Grep 规则（2026-08-27 review M2），已移除。
 *
 * fail-closed：无 error 一律按真失败算（证不了可恢复就不排除）。
 */
const RECOVERABLE_PATTERNS: RegExp[] = [
  /\btimed?\s?out\b/i, // timeout / timed out / timedout（网络慢 / 服务慢）
  /(ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection refused|not connected|network unreachable)/i, // 服务未起 / 网络超时
  /(could not resolve host|name or service not known|getaddrinfo|ENOTFOUND)/i, // DNS 解析失败
  /(permission denied|EACCES)/i, // 环境权限
]

export function isRecoverableToolFailure(error?: string): boolean {
  if (!error) return false
  const e = error.toLowerCase()
  return RECOVERABLE_PATTERNS.some((re) => re.test(e))
}
