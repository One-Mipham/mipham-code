/**
 * Mock 'bun' module for Node.js vitest environment.
 * Imported via vitest alias resolution.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { execSync } from 'node:child_process'

// ── Glob matching ──
function matchGlob(filepath: string, glob: string): boolean {
  let regexStr = glob
    .replace(/\*\*/g, '<<GLOBSTAR>>') // protect ** from * replacement
    .replace(/\*/g, '[^/]*') // * → any non-slash chars
    .replace(/<<GLOBSTAR>>/g, '<<PROTECT_DOT_STAR>>') // avoid . being escaped
    .replace(/\?/g, '<<PROTECT_DOT>>') // protect ? → . from escaping
    .replace(/\./g, '\\.') // escape literal dots
    .replace(/<<PROTECT_DOT_STAR>>/g, '.*') // restore globstar regex
    .replace(/<<PROTECT_DOT>>/g, '.') // restore ? regex
  if (!regexStr.startsWith('^')) regexStr = '^' + regexStr
  if (!regexStr.endsWith('$')) regexStr += '$'
  try {
    return new RegExp(regexStr).test(filepath)
  } catch {
    return filepath.includes(glob.replace(/\*\*?/g, ''))
  }
}

// ── Mock Glob ──
export class Glob {
  constructor(private pattern: string) {}

  async *scan(opts: { cwd?: string; absolute?: boolean } = {}) {
    const base = opts.cwd || '.'
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this

    function walk(dir: string, root: string): string[] {
      const results: string[] = []
      try {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry)
          try {
            const s = statSync(full)
            if (s.isDirectory()) {
              if (self.pattern.startsWith('**')) {
                results.push(...walk(full, root))
              }
            } else {
              const rel = relative(root, full)
              if (matchGlob(rel, self.pattern)) {
                results.push(opts.absolute ? resolve(full) : full)
              }
            }
          } catch {
            /* skip */
          }
        }
      } catch {
        /* skip */
      }
      return results
    }

    for (const f of walk(base, base)) yield f
  }
}

// ── Mock $ shell tag ──
function buildArgs(strings: TemplateStringsArray, ...values: unknown[]): string[] {
  const args: string[] = []
  for (let i = 0; i < strings.length; i++) {
    const text = strings[i]!.trim()
    if (text) args.push(...text.split(/\s+/))
    if (i < values.length) {
      const v = values[i]
      if (Array.isArray(v)) {
        args.push(...v.map(String))
      } else if (v !== null && v !== undefined && v !== '') {
        args.push(String(v))
      }
    }
  }
  return args
}

export function $(strings: TemplateStringsArray, ...values: unknown[]) {
  const args = buildArgs(strings, ...values)
  const cmd = args.join(' ')
  let _cwd: string | undefined

  const chain = {
    cwd(dir: string) {
      _cwd = dir
      return chain
    },
    quiet() {
      return chain
    },
    nothrow() {
      return chain
    },
    async text(): Promise<string> {
      try {
        return execSync(cmd, {
          encoding: 'utf-8',
          cwd: _cwd,
          maxBuffer: 50 * 1024 * 1024,
          timeout: 30_000,
        }).toString()
      } catch (e: unknown) {
        const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number }
        const msg = err.stderr?.toString() ?? String(e)
        const exitErr = Object.assign(new Error(msg.slice(0, 2000)), {
          exitCode: err.status ?? 1,
        })
        throw exitErr
      }
    },
    async lines(): Promise<string[]> {
      return (await chain.text()).split('\n')
    },
    async json(): Promise<unknown> {
      return JSON.parse(await chain.text())
    },
  }
  return chain
}

export default { Glob, $ }
