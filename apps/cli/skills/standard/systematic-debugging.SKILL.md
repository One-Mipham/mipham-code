---
name: systematic-debugging
description: Disciplined diagnosis loop for bugs, test failures, performance regressions, and unexpected behavior. Build a tight feedback loop, then minimize → hypothesize → instrument → fix → regression-test → post-mortem.
version: 1.0.0
user-invocable: true
---

# Systematic Debugging

融合 Superpowers systematic-debugging（反猜測紀律）+ Matt Pocock diagnosing-bugs（反馈闭环方法论）。

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.
NO HYPOTHESIS WITHOUT A RED-CAPABLE FEEDBACK LOOP FIRST.
```

---

## Phase 0: Decide Whether to Use This Skill

```
Issue is...
├── Test failure?            → USE THIS SKILL
├── Bug in production?       → USE THIS SKILL
├── Performance regression?  → USE THIS SKILL
├── Build/integration break? → USE THIS SKILL
├── "It's probably X, quick fix" → USE THIS SKILL (especially now)
└── Trivial typo/syntax?     → fix directly (but still verify)
```

---

## Phase 1: Build a Feedback Loop 🔴 THE SKILL

**This is the centerpiece.** A tight pass/fail signal for the bug — one that goes red on *this* bug — makes everything else mechanical. No loop = no debugging, only guessing.

Spend disproportionate effort here. Be aggressive. Be creative. Refuse to give up.

### 1.1 Ways to construct one (try in roughly this order)

1. **Failing test** at whatever seam reaches the bug — unit, integration, e2e.
2. **Curl / HTTP script** against a running dev server.
3. **CLI invocation** with fixture input, diffing stdout against known-good snapshot.
4. **Headless browser script** (Playwright/Puppeteer) — drives UI, asserts on DOM/console/network.
5. **Replay a captured trace.** Save a real network request/payload/event log to disk; replay through the code path in isolation.
6. **Throwaway harness.** Spin up minimal subset of the system (one service, mocked deps) that exercises the bug path with a single function call.
7. **Property/fuzz loop.** If "sometimes wrong output", run 1000 random inputs and look for the failure mode.
8. **Bisection harness.** Automate "boot at state X, check, repeat" so you can `git bisect run` it.
9. **Differential loop.** Run same input through old-version vs new-version and diff outputs.
10. **Multi-component evidence gathering.** For systems with multiple layers:
    ```
    For EACH component boundary:
      - Log what data enters
      - Log what data exits
      - Verify environment/config propagation
      - Check state at each layer
    
    Run once to identify WHICH layer fails, THEN investigate that component.
    ```

### 1.2 Tighten the loop

Once you have *a* loop, make it tighter:

- **Faster**: Cache setup, skip unrelated init, narrow test scope.
- **Sharper signal**: Assert on the specific symptom, not "didn't crash".
- **More deterministic**: Pin time, seed RNG, isolate filesystem, freeze network.

A 30-second flaky loop is barely better than no loop; a 2-second deterministic one is a superpower.

### 1.3 Non-deterministic bugs

Goal: higher reproduction rate (not clean repro). Loop 100×, parallelise, add stress, narrow timing windows, inject sleeps. A 50%-flake is debuggable; 1% is not — keep raising it.

### 1.4 When you genuinely cannot build a loop

Stop explicitly. List everything tried. Ask for: (a) access to the reproducing environment, (b) a redacted captured artifact (HAR file, log dump, core dump, screen recording with timestamps), or (c) permission to add temporary production instrumentation. **Do not proceed without a loop.**

### 1.5 Completion criterion

Phase 1 is done when the loop is **tight** and **red-capable**:

- [ ] **Red-capable** — drives the actual bug path and asserts the user's exact symptom. Not "runs without erroring".
- [ ] **Deterministic** — same verdict every run.
- [ ] **Fast** — seconds, not minutes.
- [ ] **Agent-runnable** — you can run it unattended.

> If you catch yourself reading code to build a theory before this loop exists — **STOP.** No red-capable command, no Phase 2.

---

## Phase 2: Reproduce + Minimise

### 2.1 Reproduce

Run the loop. Watch it go red.

- [ ] The loop produces the failure mode the **user** described — not a different nearby failure.
- [ ] The failure is reproducible (or, for flaky bugs, at a high enough rate).
- [ ] You have captured the exact symptom so later phases can verify the fix.

### 2.2 Minimise

Shrink the repro to the **smallest scenario that still goes red**. Cut inputs, callers, config, data, and steps **one at a time**, re-running the loop after each cut.

**Why**: A minimal repro shrinks the hypothesis space and becomes the clean regression test in Phase 5.

Done when **every remaining element is load-bearing** — removing any one makes the loop go green.

---

## Phase 3: Pattern Analysis + Hypothesise

### 3.1 Pattern Analysis

Before forming hypotheses:
- Find similar **working** code in the same codebase.
- Read the reference implementation completely — don't skim.
- List every difference between working and broken, however small.
- Understand dependencies, config, environment, assumptions.

### 3.2 Generate 3-5 Ranked Hypotheses

Generate multiple hypotheses **before testing any**. Single-hypothesis generation anchors on the first plausible idea.

Each hypothesis must be **falsifiable**:

> "If <X> is the cause, then <changing Y> will make the bug disappear / <changing Z> will make it worse."

If you cannot state the prediction, the hypothesis is a vibe — discard or sharpen it.

**Show the ranked list to the user before testing.** They often have domain knowledge that re-ranks instantly. Don't block on it if they're AFK.

---

## Phase 4: Instrument

Each probe must map to a specific Phase 3 prediction. **Change one variable at a time.**

Tool preference:
1. **Debugger/REPL** — one breakpoint beats ten logs.
2. **Targeted logs** at boundaries that distinguish hypotheses.
3. Never "log everything and grep".

**Tag every debug log** with a unique prefix, e.g. `[DEBUG-a4f2]`. Cleanup at the end becomes a single grep. Untagged logs survive; tagged logs die.

**Perf branch**: For performance regressions, establish a baseline measurement first (timing harness, profiler, query plan), then bisect. Measure first, fix second.

---

## Phase 5: Fix + Regression Test

### 5.1 Seam Assessment

Write the regression test **before the fix** — but only if there is a **correct seam**:

A correct seam exercises the **real bug pattern** at the call site. If the only available seam is too shallow (single-caller test when the bug needs multiple callers), a regression test there gives false confidence.

**If no correct seam exists, that itself is the finding.** Note it. The architecture is preventing the bug from being locked down.

### 5.2 If a correct seam exists

1. Turn the minimised repro into a failing test at that seam.
2. Watch it fail.
3. Apply the fix — **ONE change at a time**.
4. Watch it pass.
5. Re-run the Phase 1 feedback loop against the original (un-minimised) scenario.

### 5.3 If Fix Doesn't Work

- Try #1 failed? → Return to Phase 3, form new hypothesis.
- Try #2 failed? → Return to Phase 1, re-check the loop.
- **If 3+ fixes failed: STOP.** This is an architectural problem, not a bug:
  - Each fix reveals new problems in different places.
  - Fixes require "massive refactoring" to implement.
  - **Question the architecture, not the symptom.**
  - Discuss with your human partner before attempting more fixes.

---

## Phase 6: Cleanup + Post-Mortem

Required before declaring done:

- [ ] Original repro no longer reproduces (re-run Phase 1 loop)
- [ ] Regression test passes (or absence of seam is documented)
- [ ] All `[DEBUG-...]` instrumentation removed (`grep` the prefix)
- [ ] Throwaway prototypes deleted (or moved to a clearly-marked debug location)
- [ ] The correct hypothesis is stated in the commit/PR message

**Then ask: what would have prevented this bug?** If architectural change would have prevented it, note the specifics. You have more information now than when you started.

---

## Red Flags — STOP Immediately

If you catch yourself thinking:

| Thought | Reality |
|---------|---------|
| "Quick fix for now, investigate later" | First fix sets the pattern. Do it right. |
| "Just try changing X and see if it works" | Guessing. Build a loop instead (Phase 1). |
| "Add multiple changes, run tests" | Can't isolate what worked. One variable at a time. |
| "Skip the test, I'll verify manually" | Untested fixes don't stick. |
| "It's probably X, let me fix that" | Seeing symptoms ≠ understanding root cause. |
| "I don't fully understand but this might work" | Return to Phase 1. |
| "Reference too long, I'll adapt the pattern" | Partial understanding guarantees bugs. Read it completely. |
| "One more fix attempt" (after 2+ failures) | 3+ failures = architectural problem. Question the pattern. |

**ALL of these mean: STOP. Return to the earliest incomplete Phase.**

---

## Quick Reference

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Feedback Loop** | Build tight red/green signal for the bug | Deterministic, fast, agent-runnable |
| **2. Reproduce+Minimise** | Confirm + shrink to smallest load-bearing scenario | Every element is load-bearing |
| **3. Pattern+Hypothesise** | Compare working examples, rank 3-5 falsifiable hypotheses | Each hypothesis has a testable prediction |
| **4. Instrument** | One probe per prediction, tagged logs | Identify which hypothesis holds |
| **5. Fix+Regression** | Assess seam → test → single fix → verify | Bug resolved, test passes, original loop green |
| **6. Cleanup+Post-Mortem** | Remove instrumentation, document cause | Preventative insight captured |

---

## Supporting Techniques

- **Root Cause Tracing**: Trace bug backward through call stack to find original trigger. Where does the bad value originate? Keep tracing up.
- **Defense in Depth**: After fixing root cause, add validation at multiple layers so this class of bug can't recur.
- **Condition-Based Waiting**: Replace arbitrary timeouts (`sleep(5)`) with condition polling (`waitFor(selector)`).
