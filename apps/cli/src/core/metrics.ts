/**
 * Lightweight Prometheus-compatible metrics registry for mipham-code.
 *
 * Provides Counter, Gauge, and Histogram metric types compatible with
 * the Python shared/metrics.py module in MegaSystem.  Metrics are
 * collected in-memory and can be exported in Prometheus text format
 * or JSON.
 *
 * All metric types support *labels*: calling `.inc({ tool_name: 'bash' })`
 * records a value for the `tool_name="bash"` series, distinct from the
 * unlabelled series.  The registry deduplicates metric families by
 * `name + base labels`, so a family is created once and reused.
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

/** Format labels into Prometheus {...} string (keys sorted for determinism). */
function formatLabels(labels?: MetricLabels): string {
  if (!labels || Object.keys(labels).length === 0) return ''
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
  return `{${parts.join(',')}}`
}

/** Merge base labels with an extra set and format the result. */
function mergedLabels(base: MetricLabels, extra?: MetricLabels): string {
  return formatLabels({ ...base, ...(extra ?? {}) })
}

// ── Counter ──────────────────────────────────────────────────────────────

export class Counter {
  readonly name: string
  readonly help: string
  readonly baseLabels: MetricLabels
  /** key = formatted merged labels, value = running count. */
  private _series = new Map<string, number>()

  constructor(name: string, help: string, labels?: MetricLabels) {
    this.name = name
    this.help = help
    this.baseLabels = labels ?? {}
    // Seed the base series so the metric is always present (even at 0).
    this._series.set(formatLabels(this.baseLabels), 0)
  }

  /** Increment. Accepts either an amount, labels, or both via a second arg. */
  inc(amountOrLabels?: number | MetricLabels, maybeAmount?: number): void {
    let amount = 1
    let extra: MetricLabels | undefined
    if (typeof amountOrLabels === 'number') amount = amountOrLabels
    else if (amountOrLabels) extra = amountOrLabels
    if (maybeAmount !== undefined) amount = maybeAmount
    const key = mergedLabels(this.baseLabels, extra)
    this._series.set(key, (this._series.get(key) ?? 0) + amount)
  }

  /** Current value of a labelled series (base series when no labels given). */
  value(extra?: MetricLabels): number {
    return this._series.get(mergedLabels(this.baseLabels, extra)) ?? 0
  }

  /** Identity key for registry dedup (name + base labels). */
  get key(): string {
    return this.name + formatLabels(this.baseLabels)
  }

  toPrometheus(): string {
    return Array.from(this._series.entries())
      .map(([labelStr, v]) => `${this.name}${labelStr} ${v}`)
      .join('\n')
  }

  toJSON(): object {
    return {
      name: this.name,
      type: 'counter',
      help: this.help,
      series: Array.from(this._series.entries()).map(([labels, value]) => ({ labels, value })),
    }
  }
}

// ── Gauge ────────────────────────────────────────────────────────────────

export class Gauge {
  readonly name: string
  readonly help: string
  readonly baseLabels: MetricLabels
  private _series = new Map<string, number>()

  constructor(name: string, help: string, labels?: MetricLabels) {
    this.name = name
    this.help = help
    this.baseLabels = labels ?? {}
    this._series.set(formatLabels(this.baseLabels), 0)
  }

  inc(amountOrLabels?: number | MetricLabels, maybeAmount?: number): void {
    let amount = 1
    let extra: MetricLabels | undefined
    if (typeof amountOrLabels === 'number') amount = amountOrLabels
    else if (amountOrLabels) extra = amountOrLabels
    if (maybeAmount !== undefined) amount = maybeAmount
    const key = mergedLabels(this.baseLabels, extra)
    this._series.set(key, (this._series.get(key) ?? 0) + amount)
  }

  dec(amountOrLabels?: number | MetricLabels, maybeAmount?: number): void {
    let amount = 1
    let extra: MetricLabels | undefined
    if (typeof amountOrLabels === 'number') amount = amountOrLabels
    else if (amountOrLabels) extra = amountOrLabels
    if (maybeAmount !== undefined) amount = maybeAmount
    const key = mergedLabels(this.baseLabels, extra)
    this._series.set(key, (this._series.get(key) ?? 0) - amount)
  }

  set(value: number, extra?: MetricLabels): void {
    this._series.set(mergedLabels(this.baseLabels, extra), value)
  }

  value(extra?: MetricLabels): number {
    return this._series.get(mergedLabels(this.baseLabels, extra)) ?? 0
  }

  get key(): string {
    return this.name + formatLabels(this.baseLabels)
  }

  toPrometheus(): string {
    return Array.from(this._series.entries())
      .map(([labelStr, v]) => `${this.name}${labelStr} ${v}`)
      .join('\n')
  }

  toJSON(): object {
    return {
      name: this.name,
      type: 'gauge',
      help: this.help,
      series: Array.from(this._series.entries()).map(([labels, value]) => ({ labels, value })),
    }
  }
}

// ── Histogram ────────────────────────────────────────────────────────────

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

interface HistogramSeries {
  labels: MetricLabels
  count: number
  sum: number
  bucketCounts: number[]
}

export class Histogram {
  readonly name: string
  readonly help: string
  readonly baseLabels: MetricLabels
  readonly buckets: number[]
  private _series = new Map<string, HistogramSeries>()

  constructor(name: string, help: string, buckets?: number[], labels?: MetricLabels) {
    this.name = name
    this.help = help
    this.buckets = buckets ?? DEFAULT_BUCKETS
    this.baseLabels = labels ?? {}
    this._series.set(formatLabels(this.baseLabels), {
      labels: this.baseLabels,
      count: 0,
      sum: 0,
      bucketCounts: new Array(this.buckets.length).fill(0),
    })
  }

  private getSeries(extra?: MetricLabels): HistogramSeries {
    const key = mergedLabels(this.baseLabels, extra)
    let s = this._series.get(key)
    if (!s) {
      s = {
        labels: { ...this.baseLabels, ...(extra ?? {}) },
        count: 0,
        sum: 0,
        bucketCounts: new Array(this.buckets.length).fill(0),
      }
      this._series.set(key, s)
    }
    return s
  }

  observe(value: number, extra?: MetricLabels): void {
    const s = this.getSeries(extra)
    s.count++
    s.sum += value
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= (this.buckets[i] ?? Infinity)) {
        s.bucketCounts[i] = (s.bucketCounts[i] ?? 0) + 1
      }
    }
  }

  get key(): string {
    return this.name + formatLabels(this.baseLabels)
  }

  /** Total observations in the base (unlabelled) series. */
  get count(): number {
    return this._series.get(formatLabels(this.baseLabels))?.count ?? 0
  }

  /** Sum of observations in the base (unlabelled) series. */
  get sum(): number {
    return this._series.get(formatLabels(this.baseLabels))?.sum ?? 0
  }

  toPrometheus(): string {
    const lines: string[] = []
    for (const s of this._series.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        const leLabel = formatLabels({ ...s.labels, le: String(this.buckets[i]) })
        lines.push(`${this.name}_bucket${leLabel} ${s.bucketCounts[i] ?? 0}`)
      }
      const infLabel = formatLabels({ ...s.labels, le: '+Inf' })
      lines.push(`${this.name}_bucket${infLabel} ${s.count}`)
      const labelStr = formatLabels(s.labels)
      lines.push(`${this.name}_sum${labelStr} ${s.sum}`)
      lines.push(`${this.name}_count${labelStr} ${s.count}`)
    }
    return lines.join('\n')
  }

  toJSON(): object {
    return {
      name: this.name,
      type: 'histogram',
      help: this.help,
      series: Array.from(this._series.values()).map((s) => ({
        labels: s.labels,
        count: s.count,
        sum: s.sum,
        buckets: this.buckets.map((le, i) => ({ le: String(le), count: s.bucketCounts[i] ?? 0 })),
      })),
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

  /** CRSI auto-fix rule applications counter. */
  readonly crsiRuleApplications: Counter

  /** CRSI rules disabled for low effectiveness counter. */
  readonly crsiRuleDisables: Counter

  /** SIS immune system interceptions (block/fix of known error patterns). */
  readonly sisInterceptions: Counter

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

    this.crsiRuleApplications = this.counter(
      'mipham_code_crsi_rule_applications_total',
      'Number of CRSI auto-fix rule applications',
    )

    this.crsiRuleDisables = this.counter(
      'mipham_code_crsi_rule_disables_total',
      'Number of CRSI rules disabled for low effectiveness',
    )

    this.sisInterceptions = this.counter(
      'mipham_code_sis_interceptions_total',
      'Number of SIS immune system interceptions',
    )
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
