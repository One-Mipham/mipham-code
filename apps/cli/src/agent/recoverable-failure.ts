/**
 * 判「可恢复/环境性」失败 vs 真缺陷（borrow opencrabs `is_recoverable_tool_failure` 思想）。
 *
 * 可恢复失败（网络超时、连接拒绝、缺文件、环境权限）不该进成功率分母，否则会把成功率
 * 拉低、诱导 EffectivenessTracker 禁用能用的规则（openprabs #236 的坑：stale-hash 重试
 * 被误判成工具缺陷，把能用的 hashline_edit 禁了）。
 *
 * fail-closed：无 error、或非 Bash 工具，一律按真失败算（证不了可恢复就不排除）。
 */
const RECOVERABLE_PATTERNS: RegExp[] = [
  /\btimed?\s?out\b/i, // timeout / timed out（网络慢 / 服务死）
  /(ECONNREFUSED|connection refused|not connected|network unreachable)/i, // 服务未起
  /(no such file or directory|ENOENT)/i, // 缺资源，非缺陷
  /(permission denied|EACCES)/i, // 环境权限
]

export function isRecoverableToolFailure(toolName: string, error?: string): boolean {
  if (!error || toolName !== 'Bash') return false
  const e = error.toLowerCase()
  return RECOVERABLE_PATTERNS.some((re) => re.test(e))
}
