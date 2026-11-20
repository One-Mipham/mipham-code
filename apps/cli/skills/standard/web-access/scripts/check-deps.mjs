#!/usr/bin/env node
// 环境检查 + 确保 CDP Proxy 就绪（跨平台，替代 check-deps.sh）

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROXY_SCRIPT = path.join(ROOT, 'scripts', 'cdp-proxy.mjs')
const PROXY_PORT = Number(process.env.CDP_PROXY_PORT || 3456)
const TOKEN_FILE = path.join(ROOT, '.cdp-token')

// --- Node.js 版本检查 ---

function checkNode() {
  const major = Number(process.versions.node.split('.')[0])
  const version = `v${process.versions.node}`
  if (major >= 22) {
    console.log(`node: ok (${version})`)
  } else {
    console.log(`node: warn (${version}, 建议升级到 22+)`)
  }
}

// --- TCP 端口探测 ---

function checkPort(port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, host)
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

// --- Chrome 调试端口检测（DevToolsActivePort 多路径 + 常见端口回退） ---

function activePortFiles() {
  const home = os.homedir()
  const localAppData = process.env.LOCALAPPDATA || ''
  switch (os.platform()) {
    case 'darwin':
      return [
        path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
        path.join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort'),
        path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort'),
      ]
    case 'linux':
      return [
        path.join(home, '.config/google-chrome/DevToolsActivePort'),
        path.join(home, '.config/chromium/DevToolsActivePort'),
      ]
    case 'win32':
      return [
        path.join(localAppData, 'Google/Chrome/User Data/DevToolsActivePort'),
        path.join(localAppData, 'Chromium/User Data/DevToolsActivePort'),
      ]
    default:
      return []
  }
}

/**
 * Chrome 的调试 HTTP 端点在「允许远程调试」之前会回 404/403。
 * 所以 TCP 端口通 ≠ 可调试：只探端口会打印 `chrome: ok`，而代理永远连不上。
 */
async function probeChromeHttp(port, timeoutMs = 2000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await res.text()
    if (!res.ok) return { ok: false, status: res.status }
    JSON.parse(body) // 必须是真的 Chrome 调试端点，不是同端口上的别的东西
    return { ok: true, status: res.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

async function detectChromePort() {
  // 优先从 DevToolsActivePort 文件读取
  for (const filePath of activePortFiles()) {
    try {
      const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      const port = parseInt(lines[0], 10)
      if (port > 0 && port < 65536 && (await checkPort(port))) {
        return port
      }
    } catch {}
  }
  // 回退：探测常见端口
  for (const port of [9222, 9229, 9333]) {
    if (await checkPort(port)) {
      return port
    }
  }
  return null
}

// --- CDP Proxy 启动与等待 ---

function readToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    if (t) return t
  } catch {
    /* proxy 尚未生成 token */
  }
  return null
}

function httpGetJson(url, timeoutMs = 3000) {
  const token = readToken()
  return fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: token ? { 'X-CDP-Token': token } : {},
  })
    .then(async (res) => {
      try {
        return JSON.parse(await res.text())
      } catch {
        return null
      }
    })
    .catch(() => null)
}

function startProxyDetached() {
  const logFile = path.join(os.tmpdir(), 'cdp-proxy.log')
  const logFd = fs.openSync(logFile, 'a')
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    ...(os.platform() === 'win32' ? { windowsHide: true } : {}),
  })
  child.unref()
  fs.closeSync(logFd)
}

async function proxyHealth() {
  try {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function ensureProxy() {
  const targetsUrl = `http://127.0.0.1:${PROXY_PORT}/targets`

  // /targets 返回 JSON 数组即 ready
  const targets = await httpGetJson(targetsUrl)
  if (Array.isArray(targets)) {
    console.log('proxy: ready')
    return true
  }

  // proxy 活着但 Chrome 没连上：再拉起一个实例只会撞端口，
  // 真正该做的是把原因说清楚（多半是远程调试还没授权）。
  const health = await proxyHealth()
  if (health) {
    console.log(`proxy: running, but Chrome is not connected — ${health.lastError || '原因未知'}`)
    return false
  }

  // 未运行，启动并等待
  console.log('proxy: connecting...')
  startProxyDetached()

  // 等 proxy 进程就绪
  await new Promise((r) => setTimeout(r, 2000))

  for (let i = 1; i <= 15; i++) {
    const result = await httpGetJson(targetsUrl, 8000)
    if (Array.isArray(result)) {
      console.log('proxy: ready')
      return true
    }
    if (i === 1) {
      console.log('⚠️  Chrome 可能有授权弹窗，请点击「允许」后等待连接...')
    }
    await new Promise((r) => setTimeout(r, 1000))
  }

  const healthAfter = await proxyHealth()
  console.log(
    healthAfter
      ? `❌ Chrome 未连接：${healthAfter.lastError || '原因未知'}`
      : '❌ CDP Proxy 未能启动，请检查日志',
  )
  console.log(`  日志：${path.join(os.tmpdir(), 'cdp-proxy.log')}`)
  return false
}

// --- main ---

async function main() {
  checkNode()

  const chromePort = await detectChromePort()
  if (!chromePort) {
    console.log(
      'chrome: not connected — 请确保 Chrome 已打开，然后访问 chrome://inspect/#remote-debugging 并勾选 Allow remote debugging',
    )
    process.exit(1)
  }
  // TCP 开着不代表能调试：Chrome 136+ 在「允许远程调试」前会让 /json/* 回 404/403。
  const probe = await probeChromeHttp(chromePort)
  if (!probe.ok) {
    console.log(
      `chrome: not authorized (port ${chromePort}${probe.status ? `, HTTP ${probe.status}` : '，无响应'})` +
        ' — 远程调试尚未允许。请在 Chrome 打开 chrome://inspect/#remote-debugging 勾选 ' +
        'Allow remote debugging（或点弹窗的「允许」），然后重试。',
    )
    process.exit(1)
  }
  console.log(`chrome: ok (port ${chromePort})`)

  const proxyOk = await ensureProxy()
  if (!proxyOk) {
    process.exit(1)
  }

  // 列出已有站点经验
  const patternsDir = path.join(ROOT, 'references', 'site-patterns')
  try {
    const sites = fs
      .readdirSync(patternsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
    if (sites.length) {
      console.log(`\nsite-patterns: ${sites.join(', ')}`)
    }
  } catch {}
}

await main()
