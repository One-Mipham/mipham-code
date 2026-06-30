/**
 * Minimal MCP server mock — reads JSON-RPC from stdin,
 * responds to initialize + tools/list + tools/call.
 * Used by MCP transport/protocol/client tests.
 */

export {} // ensure module scope (prevents global name collisions)

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the input',
    inputSchema: {
      type: 'object' as const,
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers',
    inputSchema: {
      type: 'object' as const,
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
]

function respond(id: number, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function error(id: number, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

// Simple line-by-line JSON-RPC handler
async function main() {
  const decoder = new TextDecoder()

  // Use Bun's stdin stream
  const reader = Bun.stdin.stream().getReader()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const msg = JSON.parse(trimmed)

        if (msg.method === 'initialize') {
          respond(msg.id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
            serverInfo: { name: 'mock-server', version: '1.0.0' },
          })
        } else if (msg.method === 'tools/list') {
          respond(msg.id, { tools: TOOLS })
        } else if (msg.method === 'tools/call') {
          const { name, arguments: args } = msg.params || {}
          if (name === 'echo') {
            respond(msg.id, {
              content: [{ type: 'text', text: `Echo: ${args?.message || ''}` }],
            })
          } else if (name === 'add') {
            const sum = (args?.a || 0) + (args?.b || 0)
            respond(msg.id, {
              content: [{ type: 'text', text: `${args?.a || 0} + ${args?.b || 0} = ${sum}` }],
            })
          } else {
            error(msg.id, -32601, `Unknown tool: ${name}`)
          }
        } else if (msg.method === 'resources/list') {
          respond(msg.id, {
            resources: [
              { uri: 'file:///test/data.txt', name: 'Test Data', mimeType: 'text/plain' },
            ],
          })
        } else {
          error(msg.id, -32601, `Unknown method: ${msg.method}`)
        }
      } catch {
        // Skip unparseable
      }
    }
  }
}

main().catch(() => process.exit(1))
