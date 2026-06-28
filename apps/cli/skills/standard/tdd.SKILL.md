---
name: tdd
description: Test-Driven Development — red-green-refactor cycle with language-specific guidance and test design rules
version: 2.0.0
---

# Test-Driven Development (TDD)

## The Cycle

```
RED → GREEN → REFACTOR → repeat
```

### 1. RED — Write a Failing Test

Write the smallest test that captures the behavior you want:

- Name the test descriptively: `it('should return 0 for empty string')`
- Use the AAA pattern: **A**rrange → **A**ct → **A**ssert
- Run to confirm it **fails** (not errors — fails)
- If it passes before implementation, your test is wrong

### 2. GREEN — Make It Pass

Write the **minimum** code to make the test pass:

- Don't optimize, don't generalize, don't add features
- A hardcoded return is fine if it passes the test
- Run all tests — the new one should pass, old ones should still pass

### 3. REFACTOR — Clean Up

Improve the code while tests stay green:

- Remove duplication (test code and production code)
- Improve names, extract helpers
- Simplify logic
- Run tests after each change

## Test Design Rules

- **Deterministic**: No `Date.now()`, `Math.random()`, or network calls in test bodies
- **Isolated**: Each test sets up its own state; no test-order dependency
- **Fast**: Unit tests should run in milliseconds, not seconds
- **Readable**: Test output should explain what broke without reading source

## Language-Specific Guidance

### TypeScript / JavaScript (Vitest)

```ts
import { describe, it, expect } from 'vitest'

describe('sum', () => {
  it('should add two positive numbers', () => {
    expect(sum(2, 3)).toBe(5)
  })
  it('should handle zero', () => {
    expect(sum(0, 5)).toBe(5)
  })
})
```

File naming: `src/foo.ts` → `test/foo.test.ts`

### Python (pytest)

```python
def test_sum_positive():
    assert sum(2, 3) == 5

def test_sum_zero():
    assert sum(0, 5) == 5
```

### Go (testing package)

```go
func TestSumPositive(t *testing.T) {
    got := Sum(2, 3)
    want := 5
    if got != want {
        t.Errorf("Sum(2,3) = %d; want %d", got, want)
    }
}
```

## When NOT to TDD

- Exploratory spikes (throw away after learning)
- Configuration files and types (compile-time enforced)
- Generated code
