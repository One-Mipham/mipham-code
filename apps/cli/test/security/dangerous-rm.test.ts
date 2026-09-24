import { describe, it, expect } from 'vitest'
import { detectDangerousRm } from '../../src/security/dangerous-rm'

/**
 * A recursive `rm` whose target is not a path we can read is a recursive `rm`
 * whose target we cannot bound. The dangerous ones are the ones where the
 * *text* of the target does not name what will be deleted: a substitution, a
 * variable, or nothing at all.
 */
describe('detectDangerousRm — fires', () => {
  it('flags a target that is only command-substitution output', () => {
    for (const cmd of [
      'rm -rf "$(pwd)"',
      'rm -rf $(pwd)',
      'rm -rf `pwd`',
      'rm -rf "$(git rev-parse --show-toplevel)"',
      'rm -r "$(pwd)"',
      'rm -rf -- "$(pwd)"',
    ]) {
      expect(detectDangerousRm(cmd), cmd).not.toBeNull()
    }
  })

  it('flags a target at a variable followed by a top-level directory name', () => {
    for (const cmd of ['rm -rf $VAR/usr', 'rm -rf ${VAR}/etc', 'rm -rf "$ROOT/var"']) {
      const hit = detectDangerousRm(cmd)
      expect(hit, cmd).not.toBeNull()
      expect(hit!.kind, cmd).toBe('variable-top-level')
    }
  })

  it('flags a target derived from the working directory', () => {
    for (const cmd of ['rm -rf $PWD', 'rm -rf ${PWD}', 'rm -rf "$PWD/src"', 'rm -rf $OLDPWD']) {
      const hit = detectDangerousRm(cmd)
      expect(hit, cmd).not.toBeNull()
      expect(hit!.kind, cmd).toBe('cwd-derived')
    }
  })

  it('flags a backslash-only target', () => {
    for (const cmd of ['rm -rf \\', 'rm -rf "\\"']) {
      const hit = detectDangerousRm(cmd)
      expect(hit, cmd).not.toBeNull()
      expect(hit!.kind, cmd).toBe('backslash-only')
    }
  })

  it('sees through a wrapper prefix and a compound command', () => {
    for (const cmd of [
      'sudo rm -rf "$(pwd)"',
      'cd /tmp && rm -rf "$(pwd)"',
      'echo ok; rm -rf $PWD',
      'bash -c \'rm -rf "$(pwd)"\'',
    ]) {
      expect(detectDangerousRm(cmd), cmd).not.toBeNull()
    }
  })
})

describe('detectDangerousRm — stays quiet', () => {
  it('ignores ordinary relative and named targets', () => {
    for (const cmd of [
      'rm -rf node_modules',
      'rm -rf dist/',
      'rm -rf ./build',
      'rm -rf /tmp/scratch-dir',
      'rm -rf a b c',
      'rm -rf "my dir"',
    ]) {
      expect(detectDangerousRm(cmd), cmd).toBeNull()
    }
  })

  it('flags a target led by run-time state, even with a named suffix', () => {
    // The suffix narrows an *unknown* directory to a named entry inside it, so the
    // deletion is still anchored to whatever directory the command reaches — a
    // preceding `cd` decides it. `rm -rf node_modules` (cwd-relative, no anchor
    // segment) is the ordinary spelling and stays quiet.
    for (const [cmd, kind] of [
      ['rm -rf "$(pwd)/node_modules"', 'substitution'],
      ['rm -rf "$PWD/node_modules"', 'cwd-derived'],
    ] as const) {
      const hit = detectDangerousRm(cmd)
      expect(hit, cmd).not.toBeNull()
      expect(hit!.kind, cmd).toBe(kind)
    }
  })

  it('ignores a bare variable with no path after it', () => {
    // `$VAR` alone is not one of the enumerated shapes: we cannot tell whether
    // it is a directory or a file, and guessing here refuses ordinary cleanup.
    for (const cmd of ['rm -rf $VAR', 'rm -rf "$FILE"', 'rm -rf ${TMP_SUBDIR}']) {
      expect(detectDangerousRm(cmd), cmd).toBeNull()
    }
  })

  it('ignores a variable whose suffix is an ordinary directory name', () => {
    // `$VAR/usr` is dangerous because an unset `$VAR` is *dropped*, not empty —
    // what is left is `rm -rf /usr`. The same collapse on `node_modules` leaves
    // `/node_modules`, which is not a system directory, and the target stays the
    // project's own subdirectory. The directory name decides, not the variable.
    for (const cmd of ['rm -rf $VAR/node_modules', 'rm -rf "$ROOT/src"', 'rm -rf ${BUILD}/dist']) {
      expect(detectDangerousRm(cmd), cmd).toBeNull()
    }
  })

  it('ignores a non-recursive rm, and rm-shaped text that is not an rm call', () => {
    for (const cmd of [
      'rm file.txt',
      'rm -f file.txt',
      'rm -rf',
      'git rm -rf node_modules',
      'echo "rm -rf $(pwd)"',
      'grep -r "rm -rf" docs/',
    ]) {
      expect(detectDangerousRm(cmd), cmd).toBeNull()
    }
  })
})
