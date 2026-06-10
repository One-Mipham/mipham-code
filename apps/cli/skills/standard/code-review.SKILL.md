---
name: code-review
description: Code review automation for TypeScript, JavaScript, Python, Go, Swift, Kotlin — complexity analysis, risk assessment, bug detection, and quality scoring
version: 2.0.0
---

# Code Review Skill

Analyzes code changes for bugs, security risks, performance issues, and code quality. Generates structured review reports.

## Review Dimensions

### 1. Correctness (Bug Detection)
- Logic errors: off-by-one, inverted conditions, missing null checks
- Type safety: implicit any, missing generics, unsafe casts
- Error handling: swallowed exceptions, missing try/catch, unhandled promise rejections
- Edge cases: empty arrays, null/undefined, boundary conditions
- Race conditions: async/await ordering, shared mutable state

### 2. Security (OWASP Top 10)
- Injection vulnerabilities (SQL, NoSQL, command, template)
- XSS vectors (innerHTML, dangerouslySetInnerHTML, unescaped output)
- Authentication/authorization bypass
- Sensitive data exposure (logs, error messages, client-side)
- Path traversal and file inclusion
- Insecure deserialization

### 3. Performance
- N+1 queries (database in loops, repeated API calls)
- Memory leaks (unclosed connections, event listeners, timers)
- Unnecessary re-renders (React) or re-computations
- Large bundle sizes (heavy imports, missing tree-shaking)
- Missing caching or memoization where beneficial

### 4. Code Quality
- SOLID principles violations
- Code duplication (DRY violations)
- Cyclomatic complexity > 10
- Function length > 50 lines
- Deep nesting > 4 levels
- Magic numbers and strings
- Unclear naming

### 5. Architecture & Design
- Tight coupling between modules
- Circular dependencies
- Missing abstraction layers (when needed)
- Over-engineering (unnecessary abstractions)
- God objects / classes with too many responsibilities

### 6. Testing
- Missing tests for new code
- Test coverage gaps for edge cases
- Flaky tests (non-deterministic)
- Slow tests (> 1s per test)
- Test isolation issues (shared state)

### 7. Language-Specific Checks

**TypeScript/JavaScript:**
- Prefer `const` over `let`; avoid `var`
- Use optional chaining (`?.`) and nullish coalescing (`??`)
- Async functions should have try/catch
- No `any` without explicit reason
- Prefer `interface` over `type` for object shapes

**Python:**
- Type hints on function signatures
- Context managers for resources (`with` statements)
- List comprehensions over `map`/`filter` with lambdas
- No mutable default arguments

**Go:**
- Error handling (never ignore errors)
- Goroutine lifecycle (no leaks)
- defer for cleanup
- Interface segregation

## Review Report Format

```
Code Review Report
==================
Branch: <branch>
Files Changed: <count>
Review Date: YYYY-MM-DD

Summary
-------
Critical: N | High: N | Medium: N | Low: N | Info: N

Findings
--------
### [Severity] [Category]: [Title]
File: `path/to/file.ts:line`
Description: [What was found]
Risk: [Why it matters]
Fix: [How to resolve, with code example if applicable]

Score
-----
Security:    ★★★★☆
Performance: ★★★★☆
Quality:     ★★★★☆
Testing:     ★★★★☆
Overall:     ★★★★☆
```
