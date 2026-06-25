#!/usr/bin/env bun
/**
 * Mipham Code — Bun-native entry point for compiled binary.
 * Used by `bun build --compile` to produce standalone executables.
 */

async function main() {
  try {
    const { runApp } = await import('../src/index')
    await runApp({})
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('react-devtools-core')) {
      process.stderr.write(`
\`mipham\` compiled binary is missing a required dependency.

Reinstall Mipham Code:
  npm install -g @miphamai/cli
  mipham

Or use the shell script installer:
  curl -fsSL https://onemipham.com/install.sh | bash

Docs: https://onemipham.com/mipham-code
`)
      process.exit(1)
    }
    throw err
  }
}

main()
