/** 指数退避，封顶 30s。三频道（telegram/wecom/dingtalk）重连共享。 */
export function nextBackoff(currentMs: number): number {
  return Math.min(currentMs * 2, 30_000)
}
