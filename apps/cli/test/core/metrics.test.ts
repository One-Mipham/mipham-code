import { describe, it, expect, beforeEach } from 'vitest'
import {
  Counter,
  Gauge,
  Histogram,
  getMetrics,
  resetMetrics,
} from '../../src/core/metrics'

// ── Counter ──────────────────────────────────────────────────────────────

describe('Counter', () => {
  it('starts at zero', () => {
    const c = new Counter('test_total', 'Test counter')
    expect(c.value).toBe(0)
  })

  it('inc() increments by 1 by default', () => {
    const c = new Counter('test_total', 'Test counter')
    c.inc()
    expect(c.value).toBe(1)
  })

  it('inc(n) increments by n', () => {
    const c = new Counter('test_total', 'Test counter')
    c.inc(5)
    c.inc(3)
    expect(c.value).toBe(8)
  })

  it('toPrometheus format', () => {
    const c = new Counter('test_total', 'Test counter')
    c.inc(42)
    expect(c.toPrometheus()).toBe('test_total 42')
  })

  it('toPrometheus with labels', () => {
    const c = new Counter('test_total', 'Test counter', { tool: 'bash' })
    c.inc(7)
    expect(c.toPrometheus()).toBe('test_total{tool="bash"} 7')
  })

  it('toJSON returns correct structure', () => {
    const c = new Counter('test_total', 'Test counter', { app: 'cli' })
    c.inc(3)
    const j = c.toJSON()
    expect(j).toEqual({
      name: 'test_total',
      type: 'counter',
      help: 'Test counter',
      labels: { app: 'cli' },
      value: 3,
    })
  })

  it('key is unique per name+labels', () => {
    const a = new Counter('x', 'h', { a: '1' })
    const b = new Counter('x', 'h', { a: '2' })
    expect(a.key).not.toBe(b.key)
  })
})

// ── Gauge ────────────────────────────────────────────────────────────────

describe('Gauge', () => {
  it('starts at zero', () => {
    const g = new Gauge('test_gauge', 'Test gauge')
    expect(g.value).toBe(0)
  })

  it('inc() and dec()', () => {
    const g = new Gauge('test_gauge', 'Test gauge')
    g.inc(5)
    g.dec(2)
    expect(g.value).toBe(3)
  })

  it('set() overwrites value', () => {
    const g = new Gauge('test_gauge', 'Test gauge')
    g.inc(10)
    g.set(42)
    expect(g.value).toBe(42)
  })

  it('toPrometheus format', () => {
    const g = new Gauge('test_gauge', 'Test gauge')
    g.set(7)
    expect(g.toPrometheus()).toBe('test_gauge 7')
  })
})

// ── Histogram ────────────────────────────────────────────────────────────

describe('Histogram', () => {
  it('starts with zero count and sum', () => {
    const h = new Histogram('test_ms', 'Test histogram')
    expect(h.count).toBe(0)
    expect(h.sum).toBe(0)
  })

  it('observe() increments count and sum', () => {
    const h = new Histogram('test_ms', 'Test histogram')
    h.observe(100)
    h.observe(200)
    expect(h.count).toBe(2)
    expect(h.sum).toBe(300)
  })

  it('observe() distributes into correct buckets', () => {
    const h = new Histogram('test_ms', 'Test histogram', [50, 100, 250, 500])
    h.observe(30) // falls in <=50
    h.observe(80) // falls in <=100
    h.observe(300) // falls in <=500
    h.observe(1000) // falls in +Inf only

    const text = h.toPrometheus()
    // le=50 bucket should have 1 (30)
    expect(text).toContain('test_ms_bucket{le="50"} 1')
    // le=100 bucket should have 2 (30, 80) — cumulative
    expect(text).toContain('test_ms_bucket{le="100"} 2')
    // le=250 bucket should have 2 (30, 80) — 300 not included
    expect(text).toContain('test_ms_bucket{le="250"} 2')
    // le=500 bucket should have 3 (30, 80, 300)
    expect(text).toContain('test_ms_bucket{le="500"} 3')
    // le=+Inf should have 4 (all)
    expect(text).toContain('test_ms_bucket{le="+Inf"} 4')
    // sum and count
    expect(text).toContain('test_ms_sum 1410')
    expect(text).toContain('test_ms_count 4')
  })

  it('toJSON includes bucket structure', () => {
    const h = new Histogram('test_ms', 'Test histogram', [100, 500])
    h.observe(50)
    const j = h.toJSON() as any
    expect(j.type).toBe('histogram')
    expect(j.count).toBe(1)
    expect(j.sum).toBe(50)
    expect(j.buckets).toHaveLength(3) // le=100, le=500, le=+Inf
    expect(j.buckets[0]).toEqual({ le: '100', count: 1 })
  })
})

// ── MetricsRegistry ──────────────────────────────────────────────────────

describe('MetricsRegistry', () => {
  beforeEach(() => {
    resetMetrics()
  })

  it('getMetrics returns singleton', () => {
    const a = getMetrics()
    const b = getMetrics()
    expect(a).toBe(b)
  })

  it('resetMetrics clears the singleton', () => {
    const a = getMetrics()
    resetMetrics()
    const b = getMetrics()
    expect(a).not.toBe(b)
  })

  it('counter() returns the same instance for same name', () => {
    const m = getMetrics()
    const c1 = m.counter('x', 'h')
    const c2 = m.counter('x', 'h')
    expect(c1).toBe(c2)
    c1.inc()
    expect(c2.value).toBe(1)
  })

  it('predefined metrics are available', () => {
    const m = getMetrics()
    expect(m.cliInvocations).toBeDefined()
    expect(m.toolCalls).toBeDefined()
    expect(m.modelRequests).toBeDefined()
    expect(m.modelRequestErrors).toBeDefined()
    expect(m.modelRequestDurationMs).toBeDefined()
    expect(m.activeSessions).toBeDefined()
  })

  it('toPrometheusText outputs HELP and TYPE lines', () => {
    const m = getMetrics()
    m.cliInvocations.inc()
    const text = m.toPrometheusText()
    expect(text).toContain('# HELP mipham_code_cli_invocations_total')
    expect(text).toContain('# TYPE mipham_code_cli_invocations_total counter')
    expect(text).toContain('mipham_code_cli_invocations_total 1')
  })

  it('toPrometheusText includes histogram HELP/TYPE', () => {
    const m = getMetrics()
    m.modelRequestDurationMs.observe(500)
    const text = m.toPrometheusText()
    expect(text).toContain('# HELP mipham_code_model_request_duration_ms')
    expect(text).toContain('# TYPE mipham_code_model_request_duration_ms histogram')
    expect(text).toContain('_bucket{le=')
    expect(text).toContain('_sum ')
    expect(text).toContain('_count ')
  })

  it('toJSON returns structured counters, gauges, histograms', () => {
    const m = getMetrics()
    m.cliInvocations.inc(3)
    const j = m.toJSON() as any
    expect(j.counters).toBeInstanceOf(Array)
    expect(j.gauges).toBeInstanceOf(Array)
    expect(j.histograms).toBeInstanceOf(Array)
    expect(j.counters.length).toBeGreaterThan(0)
  })

  it('HELP/TYPE lines appear once per metric name', () => {
    const m = getMetrics()
    // Create two counters with same name but different labels
    m.counter('test_x', 'help x', { a: '1' })
    m.counter('test_x', 'help x', { a: '2' })
    const text = m.toPrometheusText()
    // HELP and TYPE should appear exactly once for test_x
    const helpCount = (text.match(/# HELP test_x/g) || []).length
    const typeCount = (text.match(/# TYPE test_x/g) || []).length
    expect(helpCount).toBe(1)
    expect(typeCount).toBe(1)
  })
})

// ── Edge cases ───────────────────────────────────────────────────────────

describe('Metrics edge cases', () => {
  beforeEach(() => {
    resetMetrics()
  })

  it('labels with special characters are escaped', () => {
    const m = getMetrics()
    const c = m.counter('test', 'help', { val: 'hello"world' })
    c.inc()
    expect(c.toPrometheus()).toContain('val="hello\\"world"')
  })

  it('labels are sorted in output', () => {
    const c = new Counter('test', 'help', { b: '2', a: '1' })
    c.inc()
    expect(c.toPrometheus()).toBe('test{a="1",b="2"} 1')
  })

  it('empty labels produce no braces', () => {
    const c = new Counter('test', 'help')
    c.inc()
    expect(c.toPrometheus()).toBe('test 1')
  })

  it('reset clears all metrics', () => {
    const m = getMetrics()
    m.cliInvocations.inc(5)
    m.reset()
    // After reset, re-creating a metric gives fresh state
    const c = m.counter('mipham_code_cli_invocations_total', '...')
    expect(c.value).toBe(0)
  })
})
