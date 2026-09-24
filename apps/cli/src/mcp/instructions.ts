import type { ConnectionInfo } from './types'

/**
 * 单个 server 的 instructions 上限。
 *
 * 这是**不受我们控制**的第三方文本，且**每次请求都要重新付一遍前缀** ——
 * 一个啰嗦的 server 能靠一段自带说明把别人的预算吃光。截断而非拒绝：
 * 前半段通常正是「这个 server 该怎么用」那部分。
 */
export const MCP_INSTRUCTIONS_PER_SERVER_CAP = 2000

const TRUNCATION_MARKER = '… [truncated]'

/**
 * 把已连接 MCP server 自带的 `instructions` 拼成一段**系统提示用**的文本。
 *
 * 依据（MCP 规范）：`initialize` 的返回值里 `instructions` 是 server 运维方写的
 * 「我该怎么被使用」—— 它**不是**工具描述，没地方能寄生，不收就等于丢掉。
 *
 * 三条刻意的约束：
 *   - 没写 instructions 的 server **整段不出现**（空标题会让模型去猜一个不存在的 server）；
 *   - 按 server 名**排序**，与连接完成顺序无关 —— 同一组 server 两次拼出的必须是同一段字节，
 *     否则每次请求前缀都变，提供方的 prefix cache 全部落空；
 *   - 无话可说时返回**空串**，由调用方据此整段不注入（而不是注入一个空壳标题）。
 *
 * **已知边界**：接的是**主会话**的系统提示（`index.tsx` → `ContextManager`）。子代理自己拼
 * 提示词、且**请求读的是局部变量而非上下文**（见 `agent/sub-agent.ts` 的 `currentSystemPrompt`），
 * 所以子代理**拿不到**这一段 —— 与权限段那道班是同一个形状，但那道班里子代理是**必须**知道
 * 自己处在哪一档（不然会拒绝做已被允许的事），MCP instructions 只是「这个 server 怎么用」，
 * 拿不到不影响正确性。此处如实记下，免得被当成已覆盖。
 */
export function buildMcpInstructionsBlock(connections: ConnectionInfo[]): string {
  const sections = connections
    .filter((c) => typeof c.instructions === 'string' && c.instructions.trim() !== '')
    .slice()
    .sort((a, b) => a.config.name.localeCompare(b.config.name))
    .map((c) => {
      const raw = c.instructions!.trim()
      const body =
        raw.length > MCP_INSTRUCTIONS_PER_SERVER_CAP
          ? `${raw.slice(0, MCP_INSTRUCTIONS_PER_SERVER_CAP)}\n${TRUNCATION_MARKER}`
          : raw
      return `### ${c.config.name}\n${body}`
    })

  if (sections.length === 0) return ''

  return ['## MCP server guidance', '', ...sections].join('\n')
}
