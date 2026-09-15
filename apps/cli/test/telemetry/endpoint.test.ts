import { describe, it, expect } from 'vitest'
import {
  OFFICIAL_TELEMETRY_ENDPOINT,
  NO_ENDPOINT,
  resolveEndpoint,
  officialEndpointHost,
} from '../../src/telemetry/endpoint'

/** No env var set — the common case. */
const NO_ENV: NodeJS.ProcessEnv = {}

describe('endpoint — the published address', () => {
  it('is the receiver URL documented in docs/telemetry.md', () => {
    // Pinned as a literal on purpose: this address is published, and moving it
    // is a contract change that has to be deliberate, not a constant that
    // silently drifts with a refactor.
    expect(OFFICIAL_TELEMETRY_ENDPOINT).toBe('https://log.onemipham.com/v1/events')
  })

  it('is https, on the path the receiver serves', () => {
    const url = new URL(OFFICIAL_TELEMETRY_ENDPOINT)
    expect(url.protocol).toBe('https:')
    expect(url.pathname).toBe('/v1/events')
  })

  it('reports its host without a second, hand-copied literal', () => {
    expect(officialEndpointHost()).toBe(new URL(OFFICIAL_TELEMETRY_ENDPOINT).host)
    expect(officialEndpointHost()).toBe('log.onemipham.com')
  })
})

describe('endpoint — resolution order', () => {
  it('falls back to the official receiver, and names the default as the source', () => {
    expect(resolveEndpoint(undefined, NO_ENV)).toEqual({
      endpoint: OFFICIAL_TELEMETRY_ENDPOINT,
      source: 'default',
    })
  })

  it('prefers the user setting over the shipped default', () => {
    expect(resolveEndpoint('https://a.example/x', NO_ENV)).toEqual({
      endpoint: 'https://a.example/x',
      source: 'user',
    })
  })

  it('prefers the env var over both', () => {
    expect(
      resolveEndpoint('https://a.example/x', { MIPHAM_TELEMETRY_ENDPOINT: 'https://b.example/x' }),
    ).toEqual({ endpoint: 'https://b.example/x', source: 'env' })
  })

  it('treats an empty value as not set, at every tier', () => {
    // Empty is falsy, so it falls through rather than clearing anything. This
    // is the whole reason the `none` sentinel exists.
    expect(resolveEndpoint('', { MIPHAM_TELEMETRY_ENDPOINT: '' }).source).toBe('default')
    expect(resolveEndpoint('', NO_ENV).endpoint).toBe(OFFICIAL_TELEMETRY_ENDPOINT)
  })
})

describe('endpoint — the none sentinel', () => {
  it('resolves to no destination while still reporting the deciding tier', () => {
    expect(resolveEndpoint(NO_ENDPOINT, NO_ENV)).toEqual({ endpoint: '', source: 'user' })
    expect(resolveEndpoint(undefined, { MIPHAM_TELEMETRY_ENDPOINT: NO_ENDPOINT })).toEqual({
      endpoint: '',
      source: 'env',
    })
  })

  it('outranks the default even when the env var is merely empty', () => {
    expect(resolveEndpoint(NO_ENDPOINT, { MIPHAM_TELEMETRY_ENDPOINT: '' }).endpoint).toBe('')
  })

  it('outranks a real user endpoint set through the env var', () => {
    expect(
      resolveEndpoint('https://a.example/x', { MIPHAM_TELEMETRY_ENDPOINT: NO_ENDPOINT }).endpoint,
    ).toBe('')
  })

  it('only honours the exact string, like MIPHAM_TELEMETRY=off', () => {
    for (const nearMiss of ['NONE', 'None', ' none', 'none ', 'no', 'null']) {
      expect(resolveEndpoint(nearMiss, NO_ENV)).toEqual({ endpoint: nearMiss, source: 'user' })
    }
  })
})
