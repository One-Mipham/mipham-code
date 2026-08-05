/**
 * Lightweight Prometheus-compatible metrics registry for mipham-code.
 *
 * Provides Counter, Gauge, and Histogram metric types compatible with
 * the Python shared/metrics.py module in MegaSystem.  Metrics are
 * collected in-memory and can be exported in Prometheus text format
 * or JSON.
 *
 * Usage:
 *   import { getMetrics } from '../core/metrics.js'
 *
 *   const m = getMetrics()
 *   m.cliInvocations.inc()
 *   m.toolCalls.inc({ tool_name: 'bash' })
 *   m.modelRequestDuration.observe(150.0, { provider: 'anthropic' })
 *
 * Endpoints (via ArtifactServer):
 *   GET /metrics      — Prometheus text format
 *   GET /metrics/json — JSON format
 */

// ── Metric types ──────────────────────────────────────────────────────────

export interface MetricLabels {
  [key: string]: string
}

/** Format labels into Prometheus {...} string. */
function formatLabels(labels?: MetricLabels): string {
  if (!labels || Object.keys(labels).length === 0) return ''
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
  return `{${parts.join(',')}}`
}

// ── Counter ──────────────────────────────────────────────────────────────

export class Counter {
  readonly name: string
  readonly help: string
  readonly labels: MetricLabels
  private _value = 0

  constructor(name: string, help: string, labels?: MetricLabels) {
    this.name = name
    this.help = help
    this.labels = labels ?? {}
  }

  inc(amount = 1): void {
    this._value += amount
  }

  get value(): number {
    return this._value
  }

  /** Full metric name with labels for dedup key. */
  get key(): string {
    return this.name + formatLabels(this.labels)
  }

  toPrometheus(): string {
    const labelStr = formatLabels(this.labels)
    return `${this.name}${labelStr} ${this._value}`
  }

  toJSON(): object {
    return {
      name: this.name,
      type: 'counter',
      help: this.help,
      labels: this.labels,
      value: this._value,
    }
  }
}

// ── Gauge ────────────────────────────────────────────────────────────────

export class Gauge {
  readonly name: string
  readonly help: string
  readonly labels: MetricLabels
  private _value = 0

  constructor(name: string, help: string, labels?: MetricLabels) {
    this.name = name
    this.help = help
    this.labels = labels ?? {}
  }

  inc(amount = 1): void {
    this._value += amount
  }

  dec(amount = 1): void {
    this._value -= amount
  }

  set(value: number): void {
    this._value = value
  }

  get value(): number {
    return this._value
  }

  get key(): string {
    return this.name + formatLabels(this.labels)
  }

  toPrometheus(): string {
    const labelStr = formatLabels(this.labels)
    return `${this.name}${labelStr} ${this._value}`
  }

  toJSON(): object {
    return {
      name: this.name,
      type: 'gauge',
      help: this.help,
      labels: this.labels,
      value: this._value,
    }
  }
}

// ── Histogram ────────────────────────────────────────────────────────────

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

export class Histogram {
  readonly name: string
  readonly help: string
  readonly labels: MetricLabels
  readonly buckets: number[]
  private _count = 0
  private _sum = 0
  private _bucketCounts: number[]

  constructor(name: string, help: string, buckets?: number[], labels?: MetricLabels) {
    this.name = name
    this.help = help
    this.labels = labels ?? {}
    this.buckets = buckets ?? DEFAULT_BUCKETS
    this._bucketCounts = new Array(this.buckets.length).fill(0)
  }

  observe(value: number): void {
    this._count++
    this._sum += value
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= (this.buckets[i] ?? Infinity)) {
        this._bucketCounts[i] = (this._bucketCounts[i] ?? 0) + 1
      }
    }
  }

  get count(): number {
    return this._count
  }

  get sum(): number {
    return this._sum
  }

  get key(): string {
    return this.name + formatLabels(this.labels)
  }

  toPrometheus(): string {
    const labelStr = formatLabels(this.labels)
    const lines: string[] = []

    // _bucket values
    for (let i = 0; i < this.buckets.length; i++) {
      const bucketLabel = formatLabels({
        ...this.labels,
        le: String(this.buckets[i]),
      })
      lines.push(`${this.name}_bucket${bucketLabel} ${this._bucketCounts[i]}`)
    }
    // +Inf bucket
    const infLabel = formatLabels({ ...this.labels, le: '+Inf' })
    lines.push(`${this.name}_bucket${infLabel} ${this._count}`)

    // _sum and _count
    lines.push(`${this.name}_sum${labelStr} ${this._sum}`)
    lines.push(`${this.name}_count${labelStr} ${this._count}`)

    return lines.join('\n')
  }

  toJSON(): object {
    const bucketResults: { le: string; count: number }[] = []
    for (let i = 0; i < this.buckets.length; i++) {
      bucketResults.push({ le: String(this.buckets[i]), count: this._bucketCounts[i] ?? 0 })
    }
    bucketResults.push({ le: '+Inf', count: this._count })
    return {
      name: this.name,
      type: 'histogram',
      help: this.help,
      labels: this.labels,
      count: this._count,
      sum: this._sum,
      buckets: bucketResults,
    }
  }
}

// ── MetricsRegistry ──────────────────────────────────────────────────────

export class MetricsRegistry {
  private _counters = new Map<string, Counter>()
  private _gauges = new Map<string, Gauge>()
  private _histograms = new Map<string, Histogram>()

  // ── Predefined metrics ─────────────────────────────────────────

  /** CLI invocation counter. Incremented on each CLI startup. */
  readonly cliInvocations: Counter

  /** Tool call counter, labelled by tool_name.  Callers use .inc({tool_name}). */
  readonly toolCalls: Counter

  /** Model API request counter, labelled by provider and model. */
  readonly modelRequests: Counter

  /** Model API request error counter, labelled by provider and error type. */
  readonly modelRequestErrors: Counter

  /** Model API request latency histogram (milliseconds). */
  readonly modelRequestDurationMs: Histogram

  /** Active CLI sessions gauge. */
  readonly activeSessions: Gauge

  constructor() {
    // Pre-register standard metrics
    this.cliInvocations = this.counter(
      'mipham_code_cli_invocations_total',
      'Number of CLI invocations',
    )

    this.toolCalls = this.counter('mipham_code_tool_calls_total', 'Number of tool invocations')

    this.modelRequests = this.counter(
      'mipham_code_model_requests_total',
      'Number of model API requests',
    )

    this.modelRequestErrors = this.counter(
      'mipham_code_model_request_errors_total',
      'Number of model API request errors',
    )

    this.modelRequestDurationMs = this.histogram(
      'mipham_code_model_request_duration_ms',
      'Model API request duration in milliseconds',
      [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
    )

    this.activeSessions = this.gauge('mipham_code_active_sessions', 'Number of active CLI sessions')
  }

  // ── Factory methods ─────────────────────────────────────────────

  counter(name: string, help: string, labels?: MetricLabels): Counter {
    const c = new Counter(name, help, labels)
    if (this._counters.has(c.key)) return this._counters.get(c.key)!
    this._counters.set(c.key, c)
    return c
  }

  gauge(name: string, help: string, labels?: MetricLabels): Gauge {
    const g = new Gauge(name, help, labels)
    if (this._gauges.has(g.key)) return this._gauges.get(g.key)!
    this._gauges.set(g.key, g)
    return g
  }

  histogram(name: string, help: string, buckets?: number[], labels?: MetricLabels): Histogram {
    const h = new Histogram(name, help, buckets, labels)
    if (this._histograms.has(h.key)) return this._histograms.get(h.key)!
    this._histograms.set(h.key, h)
    return h
  }

  // ── Export ──────────────────────────────────────────────────────

  /** Export all metrics in Prometheus text format. */
  toPrometheusText(): string {
    const lines: string[] = []
    const seen = new Set<string>()

    for (const c of this._counters.values()) {
      if (!seen.has(c.name)) {
        lines.push(`# HELP ${c.name} ${c.help}`)
        lines.push(`# TYPE ${c.name} counter`)
        seen.add(c.name)
      }
      lines.push(c.toPrometheus())
    }

    for (const g of this._gauges.values()) {
      if (!seen.has(g.name)) {
        lines.push(`# HELP ${g.name} ${g.help}`)
        lines.push(`# TYPE ${g.name} gauge`)
        seen.add(g.name)
      }
      lines.push(g.toPrometheus())
    }

    for (const h of this._histograms.values()) {
      if (!seen.has(h.name)) {
        lines.push(`# HELP ${h.name} ${h.help}`)
        lines.push(`# TYPE ${h.name} histogram`)
        seen.add(h.name)
      }
      lines.push(h.toPrometheus())
    }

    return lines.join('\n') + '\n'
  }

  /** Export all metrics as JSON. */
  toJSON(): object {
    return {
      counters: Array.from(this._counters.values()).map((c) => c.toJSON()),
      gauges: Array.from(this._gauges.values()).map((g) => g.toJSON()),
      histograms: Array.from(this._histograms.values()).map((h) => h.toJSON()),
    }
  }

  /** Reset all metrics (useful for testing). */
  reset(): void {
    this._counters.clear()
    this._gauges.clear()
    this._histograms.clear()
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

let _instance: MetricsRegistry | null = null

/** Get the global MetricsRegistry singleton. */
export function getMetrics(): MetricsRegistry {
  if (!_instance) {
    _instance = new MetricsRegistry()
  }
  return _instance
}

/** Reset the singleton (useful for testing). */
export function resetMetrics(): void {
  if (_instance) {
    _instance.reset()
    _instance = null
  }
}
