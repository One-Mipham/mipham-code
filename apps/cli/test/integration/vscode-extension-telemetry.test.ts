/**
 * VS Code 扩展启动终端时，必须把「这个编辑器不发遥测」这个决定带给 CLI。
 *
 * 扩展自己不发数据，但它 `createTerminal()` 出来的是一条**新进程**：CLI 的遥测开关
 * 只看它自己的设置与环境变量，看不到 IDE 的选择。于是用户在 VS Code 里关掉遥测，
 * 我们这边照样发 —— 关掉的那个开关在界面上是关的，实际没关。
 *
 * 判据只能是**真跑那段代码**：`extension.js` 是 CommonJS、`require('vscode')`，
 * 不进 tsc 工程，也没有 `vscode` 包可解析。这里用 `new Function` 把它加载进一个
 * 假 `vscode` 里，然后走**用户真正走的那条路**（activate 注册的
 * `mipham-code.start` 命令）—— 不直接调内部函数，免得测的是个没人用的入口。
 */

import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const CLI_ROOT = join(dirname(import.meta.dirname), '..')
const EXT_PATH = join(CLI_ROOT, '..', '..', 'infrastructure', 'vscode', 'extension.js')

interface FakeTerminal {
  opts: Record<string, unknown>
}

/**
 * Load `extension.js` against a recording fake `vscode`.
 *
 * Returns the captured terminal and the `start` command handler as registered by
 * `activate()` — i.e. exactly what VS Code would call.
 *
 * `homeDir` 里有能跑起来的 `mipham` 与 `bun`（空文件即可）：`openMiphamTerminal`
 * 在建终端**之前**先判「这条命令真的存在吗」，找不到就只弹错误框。这层判断在
 * 本用例里是要绕过去的噪音，不是被测对象 —— 但也不能靠本机碰巧装了 bun 才通过。
 */
function loadExtension(opts: { telemetryEnabled?: boolean; homeDir: string }): {
  createTerminal: () => FakeTerminal | undefined
  start: () => void
} {
  let created: FakeTerminal | undefined
  const commands = new Map<string, () => void>()
  const config = new Map<string, unknown>([['bunPath', join(opts.homeDir, '.bun', 'bin', 'bun')]])

  const fakeVscode = {
    StatusBarAlignment: { Right: 2 },
    env: opts.telemetryEnabled === undefined ? {} : { isTelemetryEnabled: opts.telemetryEnabled },
    commands: {
      registerCommand(name: string, fn: () => void) {
        commands.set(name, fn)
        return { dispose() {} }
      },
    },
    window: {
      createTerminal(terminalOpts: Record<string, unknown>) {
        created = { opts: terminalOpts }
        return {
          get exitStatus() {
            return undefined
          },
          show() {},
          sendText() {},
          dispose() {},
        }
      },
      onDidCloseTerminal() {
        return { dispose() {} }
      },
      createStatusBarItem() {
        return { show() {}, dispose() {}, text: '', tooltip: '', command: '' }
      },
      showErrorMessage() {},
      async showInformationMessage() {
        return undefined
      },
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: opts.homeDir } }],
      getConfiguration() {
        return { get: (key: string, fallback: unknown) => config.get(key) ?? fallback }
      },
      onDidChangeConfiguration() {
        return { dispose() {} }
      },
    },
  }

  const sandboxRequire = (id: string): unknown => {
    if (id === 'vscode') return fakeVscode
    // `extension.js` 只 require 了 `vscode` 与 node 内置模块
    return createRequire(import.meta.url)(id)
  }

  const mod = { exports: {} as { activate?: (ctx: unknown) => void } }
  const load = new Function('require', 'module', 'exports', readFileSync(EXT_PATH, 'utf-8'))
  load(sandboxRequire, mod, mod.exports)

  mod.exports.activate!({
    subscriptions: [],
    // 欢迎气泡已经看过了 —— 否则它会异步再开一个终端，干扰 captured
    globalState: { get: () => true, update() {} },
  })

  return {
    createTerminal: () => created,
    start: () => commands.get('mipham-code.start')!(),
  }
}

function withHome(run: (homeDir: string) => void): void {
  const homeDir = mkdtempSync(join(tmpdir(), 'mipham-vscode-ext-'))
  const binDir = join(homeDir, '.bun', 'bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'mipham'), '')
  writeFileSync(join(binDir, 'bun'), '')

  const realHome = process.env.HOME
  process.env.HOME = homeDir
  try {
    run(homeDir)
  } finally {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    rmSync(homeDir, { recursive: true, force: true })
  }
}

describe('VS Code 扩展：IDE 关闭遥测 ⇒ 启动的 CLI 也关', () => {
  it('isTelemetryEnabled === false ⇒ 终端带 MIPHAM_TELEMETRY=off', () => {
    withHome((homeDir) => {
      const ext = loadExtension({ telemetryEnabled: false, homeDir })
      ext.start()

      const terminal = ext.createTerminal()
      // 前提：终端真的建起来了（否则下面的断言对着 undefined 空转）
      expect(terminal, 'start 命令没有建出终端').toBeDefined()
      expect(terminal!.opts.env).toEqual({ MIPHAM_TELEMETRY: 'off' })
    })
  })

  it('isTelemetryEnabled === true ⇒ 不塞变量，CLI 自己的同意规则说了算', () => {
    // 正对照：少了它，「无条件塞 off」与「按设置塞」在断言上同形 —— 而前者会
    // 让开了遥测的用户也发不出去。
    withHome((homeDir) => {
      const ext = loadExtension({ telemetryEnabled: true, homeDir })
      ext.start()

      const terminal = ext.createTerminal()
      expect(terminal).toBeDefined()
      expect(terminal!.opts.env).toBeUndefined()
    })
  })

  it('宿主没暴露这个属性 ⇒ 同样不塞（不猜）', () => {
    withHome((homeDir) => {
      const ext = loadExtension({ homeDir })
      ext.start()

      const terminal = ext.createTerminal()
      expect(terminal).toBeDefined()
      expect(terminal!.opts.env).toBeUndefined()
    })
  })
})
