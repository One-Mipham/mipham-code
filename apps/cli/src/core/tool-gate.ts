import type { HookEngine } from './hooks'
import type { ExperienceRuleEngine } from './rule-engine'
import type { PreFlightChecker } from './preflight-checker'
import type { ConstitutionLoader } from './constitution-loader'
import type { SelfCritique } from './self-critique'
import type { ProviderRegistry } from '../providers/registry'
import type { Llm } from '../providers/llm'
import { getMetrics } from './metrics'
import { createT } from '../i18n-core/t'
import enUS from '../i18n-core/locales/en-US.json'
import type { TranslationMap } from '../i18n-core/types'

const t = createT(enUS as TranslationMap, enUS as TranslationMap)

/**
 * Everything the pre-execution chain needs, resolved lazily.
 *
 * The chain was written inline in `Engine.executeTool`; `SubAgent` runs its own
 * tool loop and called none of it, so a `Write` carrying an `apiKey = "sk-…"`
 * was blocked in the main loop and executed verbatim one level down. This module
 * is the single definition both loops call — duplicating the chain in the
 * sub-agent would let the two drift again, which is the defect being fixed.
 *
 * The three constructors are getters, not instances: the engine creates them
 * lazily on first use and that laziness is deliberate (`PreFlightChecker` builds
 * the error-signature DB, `ConstitutionLoader` reads the vocabulary).
 */
export interface ToolGateDeps {
  hookEngine?: HookEngine
  ruleEngine?: ExperienceRuleEngine
  preflight?: () => PreFlightChecker
  constitution?: () => ConstitutionLoader
  selfCritique?: () => SelfCritique
  /** `crsi.preToolHook !== false` — read once by the caller, same as the engine. */
  crsiPreToolHook: boolean
  registry: ProviderRegistry
  llm?: Llm
}

export type ToolGateOutcome =
  | { ok: false; content: string; error: string; notRun?: boolean }
  | { ok: true; params: Record<string, unknown>; warnings: string[] }

/**
 * The text a principle's `audit_pattern` is matched against.
 *
 * Not `JSON.stringify(params)`. Patterns are written against source text —
 * `apiKey = "sk-…"` — while JSON spells that value `apiKey = \"sk-…\"`, so the
 * quote class `['"]` never met the escaped quote and **the most idiomatic
 * spelling was the one that could not match**. Rendering each parameter as
 * `name=value` (strings verbatim) removes the escaping question entirely and
 * also lets the key carry the signal (`{ apiKey: '…' }` → `apiKey=…`).
 */
export function toolAuditSurface(params: Record<string, unknown>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n')
}

/**
 * Run every pre-execution gate for one tool call, in the engine's order:
 * PreToolUse hook → CRSI rules → SIS preflight → constitution → self-critique.
 *
 * `params` is returned by reference when nothing rewrote it; callers use that
 * identity (`effectiveParams !== params`) to decide whether the permission gate
 * has to rule again on what will actually run.
 */
export async function runPreToolGate(
  name: string,
  params: Record<string, unknown>,
  deps: ToolGateDeps,
  sessionId: string,
): Promise<ToolGateOutcome> {
  let effectiveParams = params
  const warnings: string[] = []

  // ── PreToolUse hook ──
  if (deps.hookEngine) {
    const preResult = await deps.hookEngine.executePreToolUse(name, params, sessionId)
    if (!preResult.allowed) {
      return {
        ok: false,
        content: '',
        error: preResult.reason || t('errors.tool_blocked', { name }),
        notRun: true,
      }
    }

    // `permissionDecision` narrows only — never widens. `ask` stops the call here
    // (this CLI has no interactive approval prompt; `ask` is a hard refusal, the
    // same as the `default` mode's ask path). `allow` is deliberately **not**
    // honoured: a hook can come from the repository's own settings, so letting it
    // auto-approve is the same defect as a project-supplied agent definition that
    // grants itself `bypassPermissions` — the criterion is the *direction*, not the
    // key name. `defer` (and an absent decision) means "no override", which is
    // exactly what happens when we do nothing.
    if (preResult.permissionDecision === 'ask' || preResult.permissionDecision === 'deny') {
      return {
        ok: false,
        content: '',
        error: preResult.reason || t('errors.tool_hook_ask', { name }),
        notRun: true,
      }
    }

    if (preResult.modifiedInput) {
      effectiveParams = { ...params, ...preResult.modifiedInput }
    }

    // A hook's `additionalContext` is how every non-blocking hook speaks — the
    // exit-1 stderr, a spawn failure, an unreachable `mcp_tool` server (see
    // `core/hooks-executor.ts`). This path used to read only `allowed` /
    // `modifiedInput`, so all of it was produced and then dropped. The warnings
    // channel already reaches the model: it is prepended to the tool result.
    // A non-`[rule:…]` line is ignored by the effectiveness tracker, so pushing
    // prose here is safe.
    if (preResult.additionalContext) {
      warnings.push(preResult.additionalContext)
    }
  }

  // ── CRSI RuleEngine intercept ──
  if (deps.crsiPreToolHook !== false && deps.ruleEngine) {
    const ruleResult = deps.ruleEngine.intercept(name, effectiveParams)
    if (Object.keys(ruleResult.modified).length > 0) {
      getMetrics().crsiRuleApplications.inc()
      effectiveParams = ruleResult.modified
    }
    if (ruleResult.warnings.length > 0) {
      // Append, do not replace: this array may already hold a PreToolUse hook's
      // `additionalContext`. Every other writer below uses the spread form for the
      // same reason — assignment here would silently drop whichever was written
      // first ("two writers, one list").
      warnings.push(...ruleResult.warnings)
    }
  }

  // ── SIS PreFlightChecker — known error pattern interception ──
  if (deps.preflight) {
    const preflight = deps.preflight().check(name, effectiveParams)
    if (preflight.action === 'block') {
      getMetrics().sisInterceptions.inc()
      return {
        ok: false,
        content: preflight.warning || 'SIS 免疫系统拦截了此操作',
        error: preflight.warning || 'SIS 免疫系统拦截了此操作',
      }
    }
    if (preflight.action === 'fix' && preflight.modifiedParams) {
      getMetrics().sisInterceptions.inc()
      effectiveParams = preflight.modifiedParams
      if (preflight.warning) {
        warnings.push(preflight.warning)
      }
    }
    if (preflight.action === 'warn' && preflight.warning) {
      warnings.push(preflight.warning)
    }
  }

  // ── Mipham Constitution — constitutional principle enforcement ──
  // Block-level violations (enforce: block) halt execution immediately.
  // Warn-level violations (enforce: warn) are appended to the warnings.
  if (deps.constitution) {
    const principles = deps.constitution().getPrinciplesForTool(name)
    for (const principle of principles) {
      if (principle.enforce === 'block') {
        // Audit: check if the tool params match a violation pattern
        if (principle.audit_pattern) {
          try {
            const regex = new RegExp(principle.audit_pattern, 'i')
            if (regex.test(toolAuditSurface(effectiveParams))) {
              return {
                ok: false,
                content: `🚫 Constitution violation blocked: **${principle.id}** — ${principle.text}`,
                error: `Constitutional principle "${principle.id}" blocked this operation.`,
              }
            }
          } catch {
            // Invalid regex — skip this principle
          }
        }
      }
      if (principle.enforce === 'warn') {
        warnings.push(`⚖️ Constitution: ${principle.id} — ${principle.text}`)
      }
    }
  }

  // ── Self-Critique Hook — RLAIF-style tool-call safety verification ──
  // Uses a fast model to critique the tool call before execution.
  // Fail-open: if the critique times out or errors, the tool still executes.
  if (deps.selfCritique) {
    const selfCritique = deps.selfCritique()
    if (selfCritique.getConfig().enabled) {
      const critiqueResult = await selfCritique.critique(
        name,
        effectiveParams,
        deps.registry,
        deps.llm,
      )
      if (critiqueResult) {
        if (critiqueResult.score < selfCritique.getConfig().threshold) {
          // Score too low — block with explanation
          if (!critiqueResult.safe) {
            return {
              ok: false,
              content: `🔍 Self-Critique blocked: ${critiqueResult.reasoning}`,
              error: `Self-Critique safety check failed (score: ${(critiqueResult.score * 100).toFixed(0)}%). ${critiqueResult.correction || ''}`,
            }
          }
          // Score low but safe — warn but allow
          warnings.push(
            `🔍 Self-Critique: ${critiqueResult.reasoning}${critiqueResult.correction ? ` — Suggestion: ${critiqueResult.correction}` : ''}`,
          )
        }
      }
    }
  }

  return { ok: true, params: effectiveParams, warnings }
}
