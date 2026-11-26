import { describe, it, expect } from 'vitest'
import {
  CREDENTIAL_SENTINEL,
  getSentinelDisplay,
  maskContent,
} from '../../src/core/credential-masker'
import { initializePipeline } from '../../src/core/credential-masker/index'

// The tools import these two entry modules (`src/tools/file/*`, `src/tools/exec/*`,
// `src/index.tsx`); nothing imported them in a test, so both sat at 0% line
// coverage until the core per-file floor exposed them on 2026-11-26.
describe('credential-masker entry points (the modules the tools import)', () => {
  it('getSentinelDisplay names the file for the model', () => {
    expect(getSentinelDisplay()).toBe(CREDENTIAL_SENTINEL)
    expect(getSentinelDisplay('.env')).toBe('[Credential file masked: .env]')
  })

  it('initializePipeline registers the built-in strategies (idempotent)', () => {
    initializePipeline()
    initializePipeline()

    expect(maskContent('AWS_SECRET=abcd', { path: '**/.env', mode: 'full' })).toBe(
      CREDENTIAL_SENTINEL,
    )
  })
})
