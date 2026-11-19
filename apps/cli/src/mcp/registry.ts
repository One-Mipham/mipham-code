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
import { capMcpText } from './instructions'
import { createT } from '../i18n-core/t'
import enUS from '../i18n-core/locales/en-US.json'
import zhCN from '../i18n-core/locales/zh-CN.json'
import type { TranslationMap } from '../i18n-core/types'

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasProperties(node: Record<string, unknown>): boolean {
  return isPlainObject(node.properties) && Object.keys(node.properties).length > 0
}

interface ArgumentSurface {
  properties: Record<string, unknown>
  required?: string[]
}

function surfaceOf(node: Record<string, unknown>): ArgumentSurface {
  const required = Array.isArray(node.required)
    ? node.required.filter((name): name is string => typeof name === 'string')
    : undefined
  return {
    properties: isPlainObject(node.properties) ? node.properties : {},
    ...(required && required.length > 0 ? { required } : {}),
  }
}

/**
 * Every argument surface a schema offers.
 *
 * A server may put the union at the root (`anyOf`/`oneOf`). Reading only
 * `root.properties` made that tool reach the model with **no parameters at
 * all** — callable, but every argument invisible. Following only the *first*
 * branch fixed that and introduced the next defect one step in: a branch that
 * takes an id as a number and another that takes it as a string are two
 * spellings of one argument, and showing only the first taught the model that
 * the second was invalid. Every branch is surfaced; nested unions included.
 * The root wins when it declares properties itself, so a schema that has both
 * is not rewritten.
 */
function collectSurfaces(schema: unknown, depth = 0): ArgumentSurface[] {
  const node = isPlainObject(schema) ? schema : {}
  if (hasProperties(node)) return [surfaceOf(node)]
  if (depth >= 8) return []
  if (Array.isArray(node.allOf)) {
    const merged = mergeAllOf(node.allOf, depth)
    if (merged) return [merged]
  }
  const branches = (
    Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : []
  ).filter(isPlainObject)
  return branches.flatMap((branch) => collectSurfaces(branch, depth + 1))
}

/**
 * `allOf` is conjunction, not a menu: every branch applies at once.
 *
 * Merging it into a single surface is what makes `required` come out right —
 * a name is mandatory when *any* conjunct requires it, which is the opposite
 * of the `anyOf` rule (mandatory only when every branch does). Ignoring the
 * keyword (the state before this) left the tool callable with **no parameters
 * at all**, the same failure a root-level `anyOf` used to have.
 */
function mergeAllOf(branches: unknown[], depth: number): ArgumentSurface | null {
  const properties: Record<string, unknown> = {}
  const required = new Set<string>()
  let merged = false
  for (const branch of branches.filter(isPlainObject)) {
    for (const surface of collectSurfaces(branch, depth + 1)) {
      merged = true
      for (const [name, property] of Object.entries(surface.properties)) {
        if (isPlainObject(property) && !Object.prototype.hasOwnProperty.call(properties, name)) {
          properties[name] = property
        }
      }
      for (const name of surface.required ?? []) required.add(name)
    }
  }
  if (!merged) return null
  return required.size > 0 ? { properties, required: [...required] } : { properties }
}

/**
 * Coerce a server-declared `inputSchema` into a shape every provider accepts.
 *
 * `inputSchema` comes from another process and is not validated against JSON
 * Schema. Passing it through put the same malformed schema in front of the
 * model on *every* turn, so one broken server could make the whole session
 * unusable — not just the one tool. Only the top level is repaired: property
 * schemas that are themselves objects are kept verbatim, so this narrows
 * malformed input without rewriting a server's intent.
 *
 * A root-level `anyOf`/`oneOf` is not malformed, but it is a shape no provider
 * accepts as tool parameters — the first branch that declares properties is
 * surfaced instead of dropping the tool's whole argument surface.
 */
export function sanitizeInputSchema(schema: unknown): {
  properties: Record<string, unknown>
  required?: string[]
} {
  const surfaces = collectSurfaces(schema)
  const properties: Record<string, unknown> = {}
  for (const surface of surfaces) {
    for (const [name, property] of Object.entries(surface.properties)) {
      // First spelling wins on a name collision; the later branch is another
      // way to say the same argument, not a second argument.
      if (isPlainObject(property) && !Object.prototype.hasOwnProperty.call(properties, name)) {
        properties[name] = property
      }
    }
  }

  // A name is required only when **every** surface that mentions requirements
  // requires it. One branch needing `id` and another not is not a reason to
  // demand `id` for a call the second branch accepts.
  let required = surfaces[0]?.required ? [...surfaces[0].required] : []
  for (const surface of surfaces.slice(1)) {
    const set = new Set(surface.required ?? [])
    required = required.filter((name) => set.has(name))
  }
  required = [...new Set(required)].filter((name) =>
    Object.prototype.hasOwnProperty.call(properties, name),
  )

  return required.length > 0 ? { properties, required } : { properties }
}

/**
 * Convert an MCP server ToolDefinition into the main ToolDefinition format
 * that can be registered in the central tool registry.
 */
export function convertMcpTool(serverName: string, mcpTool: McpToolDefinition): ToolDefinition {
  const toolName = buildToolName(serverName, mcpTool.name)

  const parameters: Record<string, unknown> = {
    type: 'object',
    ...sanitizeInputSchema(mcpTool.inputSchema),
  }

  return {
    name: toolName,
    description: `[MCP:${serverName}] ${capMcpText(mcpTool.description || mcpTool.name)}`,
    category: 'system',
    permission: 'ask',
    parameters,
    async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const client = McpClient.getInstance()

      // Startup connects servers without blocking, and a resumed session re-attaches
      // them the same way — so a call can arrive while its server is still
      // handshaking. Failing outright then is wrong twice over: the tool exists, and
      // the only thing missing is patience. Same wait the `mcp_tool` hook already
      // does (`core/hooks-executor.ts`), so both entry points treat a connecting
      // server identically. A server that is *not* connecting returns immediately.
      await client.waitUntilReady(serverName, undefined, ctx.signal)

      const conn = client.getConnection(serverName)
      if (!conn || conn.status !== 'connected') {
        return {
          success: false,
          content: '',
          error: `MCP server "${serverName}" is not connected (status: ${conn?.status || 'unknown'}). The server may have crashed or been disconnected.`,
        }
      }

      const result: ToolCallResult = await client.callTool(
        serverName,
        mcpTool.name,
        params,
        ctx.signal,
      )

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
        console.error(t('errors.mcp_register_collision', { name: tool.name, server: serverName }))
        continue
      }

      toolsMap.set(tool.name, tool)
      registered++
    } catch (err) {
      console.error(
        t('errors.mcp_register_failed', {
          tool: mcpTool.name,
          server: serverName,
          error: String(err),
        }),
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

/**
 * Apply a runtime tool-list change (tools/list_changed) to the central registry.
 * Pure core of the dynamic-tool-update path: add new tools, remove stale ones.
 */
export function applyToolChanges(
  serverName: string,
  added: McpToolDefinition[],
  removed: McpToolDefinition[],
  toolsMap: Map<string, ToolDefinition>,
): { added: number; removed: number } {
  let removedCount = 0
  for (const t of removed) {
    if (toolsMap.delete(convertMcpTool(serverName, t).name)) removedCount++
  }

  let addedCount = 0
  for (const t of added) {
    const converted = convertMcpTool(serverName, t)
    toolsMap.set(converted.name, converted)
    addedCount++
  }

  return { added: addedCount, removed: removedCount }
}

/**
 * Keep the central registry in sync with runtime MCP tool changes.
 * Register once at startup — the handler is global across all connected
 * MCP servers (both config.yml and plugin).
 */
export function syncMcpToolsOnChange(
  mcpClient: McpClient,
  toolsMap: Map<string, ToolDefinition>,
): void {
  mcpClient.on('tools-changed', (name: unknown, added: unknown, removed: unknown) => {
    applyToolChanges(
      name as string,
      (added as McpToolDefinition[] | undefined) ?? [],
      (removed as McpToolDefinition[] | undefined) ?? [],
      toolsMap,
    )
  })
}
