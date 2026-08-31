/**
 * `/fix test` — LLM-driven repair of failing tests in the real repo.
 *
 * Reuses the `/crsi bench` closed loop (LLM generates → a frozen test judges the
 * result) but applied to the caller's own codebase: the failing test is the frozen
 * ground truth, and the LLM may only fix the *source*, never the test.
 */

/**
 * Extract failing test-file paths from a `vitest run` output stream. Matches the
 * ` FAIL  test/xxx.test.ts > describe > it` lines (vitest 4 default reporter).
 */
export function parseVitestFailures(output: string): string[] {
  const files = new Set<string>()
  const re = /^\s*FAIL\s+(\S+)/gm
  let m
  while ((m = re.exec(output))) {
    files.add(m[1]!)
  }
  return [...files]
}

/**
 * Extract relative import specifiers (`./foo`, `../bar`) from a test file — these
 * are the candidate source files the failing test depends on. Package imports
 * (`vitest`, `lodash`) and node builtins (`node:fs`) are ignored.
 */
export function collectLocalImports(testContent: string): string[] {
  const imports: string[] = []
  const re = /from\s+['"](\.[^'"]*)['"]/g
  let m
  while ((m = re.exec(testContent))) {
    imports.push(m[1]!)
  }
  return imports
}

/**
 * Build the LLM prompt that asks for a source-only fix. The test is declared
 * frozen ground truth; the model must return the corrected source file contents.
 */
export function buildFixPrompt(opts: {
  testPath: string
  testContent: string
  sourcePath: string
  sourceContent: string
  failure: string
}): string {
  const { testPath, testContent, sourcePath, sourceContent, failure } = opts
  return [
    'You are fixing a failing test in a real codebase.',
    '',
    'RULES:',
    '- The test file is FROZEN ground truth. Do NOT modify the test.',
    '- Only fix the SOURCE file so the test passes.',
    '- Output ONLY the corrected source file contents — no markdown fences, no explanation.',
    '',
    `Failing test: ${testPath}`,
    '```',
    testContent,
    '```',
    '',
    `Source to fix: ${sourcePath}`,
    '```',
    sourceContent,
    '```',
    '',
    'Failure:',
    failure,
  ].join('\n')
}

export interface FixCodeDeps {
  runVitest: (testFile: string) => { exitCode: number; output: string }
  readFile: (path: string) => string | null
  writeFile: (path: string, content: string) => void
  generateFix: (prompt: string) => Promise<string>
  resolveSourceFile: (testFile: string, specifier: string) => string
}

export interface FixTargetResult {
  testFile: string
  sourceFile: string | null
  fixed: boolean
  attempts: number
  detail?: string
}

/**
 * Repair one failing test: locate the first local source the test imports, ask
 * the LLM for a source-only fix, verify it against the frozen test, and apply it
 * (or restore the original in dry-run). Retries up to `maxRetries`, feeding each
 * failure back into the next prompt.
 */
export async function fixCodeTarget(
  deps: FixCodeDeps,
  testFile: string,
  opts?: { apply?: boolean; maxRetries?: number },
): Promise<FixTargetResult> {
  const apply = opts?.apply ?? false
  const maxRetries = opts?.maxRetries ?? 3

  const initial = deps.runVitest(testFile)
  if (initial.exitCode === 0) {
    return { testFile, sourceFile: null, fixed: true, attempts: 0, detail: 'test already passes' }
  }

  const testContent = deps.readFile(testFile)
  if (testContent === null) {
    return {
      testFile,
      sourceFile: null,
      fixed: false,
      attempts: 0,
      detail: 'cannot read test file',
    }
  }

  const specifiers = collectLocalImports(testContent)
  if (specifiers.length === 0) {
    return {
      testFile,
      sourceFile: null,
      fixed: false,
      attempts: 0,
      detail: 'no local imports to locate a source file',
    }
  }

  const sourceFile = deps.resolveSourceFile(testFile, specifiers[0]!)
  const sourceContent = deps.readFile(sourceFile)
  if (sourceContent === null) {
    return { testFile, sourceFile, fixed: false, attempts: 0, detail: 'cannot read source file' }
  }

  let failure = initial.output
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const prompt = buildFixPrompt({
      testPath: testFile,
      testContent,
      sourcePath: sourceFile,
      sourceContent,
      failure,
    })
    const fixedContent = await deps.generateFix(prompt)
    if (!fixedContent) continue

    deps.writeFile(sourceFile, fixedContent)
    const result = deps.runVitest(testFile)

    if (result.exitCode === 0) {
      if (!apply) deps.writeFile(sourceFile, sourceContent)
      return { testFile, sourceFile, fixed: true, attempts: attempt }
    }

    deps.writeFile(sourceFile, sourceContent)
    failure = result.output
  }

  return {
    testFile,
    sourceFile,
    fixed: false,
    attempts: maxRetries,
    detail: 'fix never passed the frozen test',
  }
}
