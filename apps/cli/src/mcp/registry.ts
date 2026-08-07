/**
 * MCP Tool Registry — converts MCP server tools into main ToolDefinitions
 * and registers them into the central tool registry.
 *
 * Naming convention: mcp__<sanitizedServerName>__<sanitizedToolName>
 * Example: server "chrome-devtools-mcp" tool "click" → "mcp__chrome_devtools_mcp__click"
 */

import type { ToolDefinition as McpToolDefinition, ToolCallResult } from './types'
import type { ToolDefinition, ToolResult, ToolContext } from '../shared/types'
import { McpClient } from './client'
import { createT } from '@mipham/shared/i18n/t'
import enUS from '@mipham/shared/i18n/locales/en-US.json'
import zhCN from '@mipham/shared/i18n/locales/zh-CN.json'
import type { TranslationMap } from '@mipham/shared/i18n/types'

const bundles: Record<string, TranslationMap> = {
  'en-US': enUS as TranslationMap,
  'zh-CN': zhCN as TranslationMap,
}
const t = createT(bundles['en-US'] || (enUS as TranslationMap), enUS as TranslationMap)

const MCP_TOOL_PREFIX = 'mcp__'
const MAX_NAME_LENGTH = 128

/**
 * Sanitize a name for use in a tool identifier.
 * Lowercases and replaces non-alphanumeric characters (except hyphens) with underscores.
 */
function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

/**
 * Build a namespaced MCP tool name.
 * Format: mcp__<sanitizedServerName>__<sanitizedToolName>
 */
function buildToolName(serverName: string, toolName: string): string {
  const base = `${MCP_TOOL_PREFIX}${sanitizeName(serverName)}__${sanitizeName(toolName)}`
  if (base.length <= MAX_NAME_LENGTH) return base
  const prefix = `${MCP_TOOL_PREFIX}${sanitizeName(serverName)}__`
  const maxToolLen = MAX_NAME_LENGTH - prefix.length
  return prefix + sanitizeName(toolName).slice(0, maxToolLen)
}

/**
 * Convert an MCP server ToolDefinition into the main ToolDefinition format
 * that can be registered in the central tool registry.
 */
export function convertMcpTool(serverName: string, mcpTool: McpToolDefinition): ToolDefinition {
  const toolName = buildToolName(serverName, mcpTool.name)

  // Build parameters schema — pass through MCP inputSchema as-is
  const parameters: Record<string, unknown> = {
    type: 'object',
    properties: (mcpTool.inputSchema.properties as Record<string, unknown>) ?? {},
  }
  if (mcpTool.inputSchema.required) {
    parameters.required = mcpTool.inputSchema.required
  }

  return {
    name: toolName,
    description: `[MCP:${serverName}] ${mcpTool.description || mcpTool.name}`,
    category: 'system',
    permission: 'ask',
    parameters,
    async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const client = McpClient.getInstance()

      const conn = client.getConnection(serverName)
      if (!conn || conn.status !== 'connected') {
        return {
          success: false,
          content: '',
          error: `MCP server "${serverName}" is not connected (status: ${conn?.status || 'unknown'}). The server may have crashed or been disconnected.`,
        }
      }

      const result: ToolCallResult = await client.callTool(serverName, mcpTool.name, params)

      const text = result.content
        .map((c) => {
          if (c.type === 'text' && c.text) return c.text
          if (c.type === 'image') return `[Image: ${c.mimeType || 'unknown'}]`
          return JSON.stringify(c)
        })
        .join('\n')

      return {
        success: !result.isError,
        content: text || '(empty result)',
        error: result.isError ? text : undefined,
      }
    },
  }
}

/**
 * Register all tools from a connected MCP server into the tool registry.
 * Returns the number of tools registered.
 */
export function registerMcpServerTools(
  serverName: string,
  toolsMap: Map<string, ToolDefinition>,
): number {
  const client = McpClient.getInstance()
  const mcpTools = client.getTools(serverName)
  let registered = 0

  for (const mcpTool of mcpTools) {
    try {
      const tool = convertMcpTool(serverName, mcpTool)

      if (toolsMap.has(tool.name)) {
        process.stderr.write(
          t('errors.mcp_register_collision', { name: tool.name, server: serverName }) + '\n',
        )
        continue
      }

      toolsMap.set(tool.name, tool)
      registered++
    } catch (err) {
      process.stderr.write(
        t('errors.mcp_register_failed', {
          tool: mcpTool.name,
          server: serverName,
          error: String(err),
        }) + '\n',
      )
    }
  }

  return registered
}

/**
 * Unregister all tools previously registered from a specific MCP server.
 * Tools are identified by the mcp__<serverName>__ prefix.
 */
export function unregisterMcpServerTools(
  serverName: string,
  toolsMap: Map<string, ToolDefinition>,
): void {
  const prefix = `${MCP_TOOL_PREFIX}${sanitizeName(serverName)}__`
  for (const name of toolsMap.keys()) {
    if (name.startsWith(prefix)) {
      toolsMap.delete(name)
    }
  }
}
