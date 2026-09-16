#!/usr/bin/env bun

/**
 * Mipham Code Daemon — standalone source-mode entry.
 *
 * The compiled binary reaches the same code through the hidden `__daemon`
 * branch in bin/mipham.ts. Both call runDaemonProcess() so there is exactly
 * one implementation of the daemon process body.
 *
 * Usage: bun run bin/daemon.ts [--port PORT] [--bind HOST]
 */

import { runDaemonProcess } from '../src/daemon/launch'

await runDaemonProcess()
