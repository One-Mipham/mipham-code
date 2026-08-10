#!/usr/bin/env bun

/**
 * Mipham Code Daemon — standalone background process.
 * Spawned by `mipham daemon start`.
 *
 * Usage: bun run bin/daemon.ts [--port PORT] [--bind HOST]
 */

import { startDaemon } from '../src/daemon/index'

const args = process.argv.slice(2)

// Parse --port and --bind from CLI args (passed by mipham CLI)
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    process.env.MIPHAM_PORT = args[i + 1]!
  }
  if (args[i] === '--bind' && args[i + 1]) {
    process.env.MIPHAM_BIND = args[i + 1]!
  }
}

const { port } = await startDaemon()

console.log(`Daemon running on http://127.0.0.1:${port}`)
console.log(`PID: ${process.pid}`)

// Keep process alive
process.on('SIGTERM', async () => {
  const { stopDaemon } = await import('../src/daemon/index')
  await stopDaemon(true)
  process.exit(0)
})

process.on('SIGINT', async () => {
  const { stopDaemon } = await import('../src/daemon/index')
  await stopDaemon(true)
  process.exit(0)
})
