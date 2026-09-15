import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `tsc` emits JavaScript for `.ts` files and nothing else.
 *
 * So any file the running service reads from disk — `src/allowlist.json` today
 * — is absent from the build unless the build script copies it. The failure is
 * invisible to the test suite: vitest transforms TypeScript in place, so
 * `import.meta.url` is inside `src/` and the sibling JSON is right there. It
 * only appears in the artefact that actually ships, where it is a startup
 * ENOENT and — under systemd with `Restart=on-failure` — a restart loop.
 *
 * This is the same class of mistake as the coverage thresholds with no CI step
 * that ran them: the configuration was right, and nothing proved the thing that
 * consumed it was pointed at it. Checked structurally rather than by building,
 * because the test job never produces a `dist/`.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '../..')
const SRC = join(APP_ROOT, 'src')

const MANIFEST = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf-8')) as {
  scripts?: Record<string, string>
}

function walk(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...walk(path))
    else if (statSync(path).isFile()) found.push(path)
  }
  return found
}

/** Every file under `src/` that `tsc` will not emit, as a `src/`-relative path. */
function dataFiles(): string[] {
  return walk(SRC)
    .filter((path) => !path.endsWith('.ts'))
    .map((path) => relative(SRC, path))
    .sort()
}

/** The build copies a file when both its source and its destination are named. */
function copiesFile(script: string, file: string): boolean {
  return script.includes(`src/${file}`) && script.includes(`dist/${file}`)
}

const BUILD = MANIFEST.scripts?.['build'] ?? ''
const DATA_FILES = dataFiles()

describe('the build produces an artefact the service can actually run', () => {
  it('finds the data files, starting with the one this guard exists for', () => {
    // Without this the loop below could iterate an empty list and pass
    // vacuously — the discovery itself has to be shown to work.
    expect(DATA_FILES).toContain('allowlist.json')
  })

  it.each(DATA_FILES)('copies src/%s into dist/', (file) => {
    expect(copiesFile(BUILD, file), `build script is: ${BUILD}`).toBe(true)
  })

  it('runs the service out of the same directory the build writes to', () => {
    // The copy step above is only load-bearing if `start` reads that directory.
    // A build that copies into `build/` while `start` runs `dist/server.js`
    // would satisfy the previous assertion and still fail at startup.
    expect(MANIFEST.scripts?.['start']).toContain('dist/')
    expect(BUILD).toContain('-p tsconfig.build.json')
    expect(readFileSync(join(APP_ROOT, 'tsconfig.build.json'), 'utf-8')).toContain('"./dist"')
  })

  it('is not fooled by a build that only compiles', () => {
    // The exact shape this guard was written against.
    expect(copiesFile('tsc -p tsconfig.build.json', 'allowlist.json')).toBe(false)
    // Naming the destination alone is not a copy either.
    expect(copiesFile('tsc -p tsconfig.build.json # dist/allowlist.json', 'allowlist.json')).toBe(
      false,
    )
  })
})
