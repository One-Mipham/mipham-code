// apps/cli/test/daemon/workspace-guard.test.ts
import { describe, it, expect } from 'vitest'
import { isCwdAllowed } from '../../src/daemon/workspace-guard'

const ROOT = '/Users/dev/project'
const noTrust = () => false

describe('isCwdAllowed', () => {
  it('accepts the daemon root and directories beneath it', () => {
    expect(isCwdAllowed(ROOT, noTrust, ROOT)).toBe(true)
    expect(isCwdAllowed(`${ROOT}/apps/cli`, noTrust, ROOT)).toBe(true)
  })

  it('rejects a sibling that merely shares the root prefix', () => {
    expect(isCwdAllowed('/Users/dev/project-secrets', noTrust, ROOT)).toBe(false)
  })

  it('rejects traversal out of the daemon root', () => {
    expect(isCwdAllowed(`${ROOT}/../../../etc`, noTrust, ROOT)).toBe(false)
  })

  it('rejects a home directory — the arbitrary-read target', () => {
    expect(isCwdAllowed('/Users/dev', noTrust, ROOT)).toBe(false)
  })

  it('accepts a directory outside the root when the user trusts it', () => {
    // The ancestor/descendant walk belongs to WorkspaceTrust.isTrusted — the
    // guard passes the caller's cwd through unchanged and honours its verdict.
    const trusted = '/Volumes/work/other'
    const isTrusted = (dir: string) => dir === trusted || dir.startsWith(`${trusted}/`)
    expect(isCwdAllowed(trusted, isTrusted, ROOT)).toBe(true)
    expect(isCwdAllowed(`${trusted}/nested`, isTrusted, ROOT)).toBe(true)
  })

  it('does not accept an untrusted directory merely because it is outside the root', () => {
    expect(isCwdAllowed('/Volumes/work/other', noTrust, ROOT)).toBe(false)
  })

  it('rejects empty and non-string values', () => {
    expect(isCwdAllowed('', noTrust, ROOT)).toBe(false)
    expect(isCwdAllowed(undefined as unknown as string, noTrust, ROOT)).toBe(false)
    expect(isCwdAllowed(42 as unknown as string, noTrust, ROOT)).toBe(false)
  })
})
