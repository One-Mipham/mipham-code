import { describe, it, expect } from 'vitest'
import { detectWorldWritableChmod } from '../../src/security/world-writable-chmod'

/**
 * A recursive `chmod` that hands world-write to a target the command does not
 * bound is the one call shape the `auto` gate measurably cannot judge: over 5
 * samples each, the reasoning model allowed it 1/5 and the fast model 4/5 — the
 * widest swing in the set (measured 2026-09-30). Both halves of that are
 * structural, so the ruling is decidable from the text:
 *
 * - the *grant* is in the mode token (`777`, `o+w`, `a=rwx`, …), and
 * - the *bound* is the target: `/tmp/shared` and `$DIR` reach past any boundary
 *   the command states, while `./dist` names one.
 *
 * The dangerous ones are the ones where the target does not name where the write
 * lands. `chmod -R 777 ./dist` is routine and must stay routine.
 */
describe('detectWorldWritableChmod — fires', () => {
  it('flags an absolute target', () => {
    for (const cmd of [
      'chmod -R 777 /tmp/shared',
      'chmod -R 777 /var/www',
      'chmod --recursive 777 /srv',
    ]) {
      expect(detectWorldWritableChmod(cmd), cmd).not.toBeNull()
    }
  })

  it('flags a home-anchored target', () => {
    for (const cmd of ['chmod -R 777 ~/shared', 'chmod -R a+w ~/x', 'chmod -R 777 ~']) {
      const hit = detectWorldWritableChmod(cmd)
      expect(hit, cmd).not.toBeNull()
      expect(hit!.kind, cmd).toBe('home')
    }
  })

  it('flags a variable-led target', () => {
    for (const cmd of ['chmod -R 777 $DIR', 'chmod -R 777 ${DIR}', 'chmod -R 777 "$DIR/sub"']) {
      const hit = detectWorldWritableChmod(cmd)
      expect(hit, cmd).not.toBeNull()
      expect(hit!.kind, cmd).toBe('variable')
    }
  })

  it('flags a substitution-led target', () => {
    for (const cmd of [
      'chmod -R 777 "$(pwd)"',
      'chmod -R 777 $(pwd)',
      'chmod -R 777 `pwd`',
      'chmod -R 777 "$(git rev-parse --show-toplevel)"',
    ]) {
      const hit = detectWorldWritableChmod(cmd)
      expect(hit, cmd).not.toBeNull()
      expect(hit!.kind, cmd).toBe('substitution')
    }
  })

  it('flags a target that climbs out of the directory the command is in', () => {
    for (const cmd of ['chmod -R 777 ../shared', 'chmod -R 777 ..']) {
      const hit = detectWorldWritableChmod(cmd)
      expect(hit, cmd).not.toBeNull()
      expect(hit!.kind, cmd).toBe('parent')
    }
  })

  it('reads world-write out of a symbolic mode, not just the literal 777', () => {
    for (const cmd of [
      'chmod -R o+w /tmp/shared',
      'chmod -R a+w /tmp/shared',
      'chmod -R +w /tmp/shared',
      'chmod -R o=rwx /tmp/shared',
      'chmod -R a+rw /tmp/shared',
    ]) {
      expect(detectWorldWritableChmod(cmd), cmd).not.toBeNull()
    }
  })

  it('reads world-write out of any octal mode whose other-digit carries it', () => {
    for (const cmd of ['chmod -R 776 /tmp/x', 'chmod -R 707 /tmp/x', 'chmod -R 4777 /tmp/x']) {
      expect(detectWorldWritableChmod(cmd), cmd).not.toBeNull()
    }
  })

  it('sees through a wrapper prefix and a compound command', () => {
    for (const cmd of [
      'sudo chmod -R 777 /tmp/shared',
      'cd /tmp && chmod -R 777 /tmp/shared',
      'echo ok; chmod -R 777 $DIR',
      "bash -c 'chmod -R 777 /tmp/shared'",
    ]) {
      expect(detectWorldWritableChmod(cmd), cmd).not.toBeNull()
    }
  })

  it('flags the unbounded target even when a bounded one is named first', () => {
    const hit = detectWorldWritableChmod('chmod -R 777 ./dist /tmp/shared')
    expect(hit).not.toBeNull()
    expect(hit!.target).toBe('/tmp/shared')
  })
})

describe('detectWorldWritableChmod — stays quiet', () => {
  it('ignores a target that names where the write lands', () => {
    for (const cmd of [
      'chmod -R 777 ./dist',
      'chmod -R 777 dist',
      'chmod -R 777 ./dist/',
      'chmod -R o+w build',
      'chmod -R 777 "my dir"',
    ]) {
      expect(detectWorldWritableChmod(cmd), cmd).toBeNull()
    }
  })

  it('ignores modes that do not grant world-write', () => {
    for (const cmd of [
      'chmod -R 755 /tmp/shared',
      'chmod -R 775 /tmp/shared',
      'chmod -R 700 /tmp/shared',
      'chmod -R u+w /tmp/shared',
      'chmod -R g+w /tmp/shared',
      'chmod -R go-w /tmp/shared',
    ]) {
      expect(detectWorldWritableChmod(cmd), cmd).toBeNull()
    }
  })

  it('ignores a non-recursive chmod', () => {
    // Ordinary single-file permission work, and a shape the Bash tool's own
    // BLOCKED_PATTERNS already refuses when the target is absolute. Widening to
    // it here would refuse routine work for no measured gain.
    for (const cmd of ['chmod 777 /tmp/shared', 'chmod o+w /tmp/shared', 'chmod +x script.sh']) {
      expect(detectWorldWritableChmod(cmd), cmd).toBeNull()
    }
  })

  it('ignores commands that are not chmod', () => {
    for (const cmd of [
      'chown -R 777 /tmp/shared',
      'ls -R /tmp/shared',
      'echo "chmod -R 777 /tmp/shared"',
      'chmod --version',
    ]) {
      expect(detectWorldWritableChmod(cmd), cmd).toBeNull()
    }
  })
})
