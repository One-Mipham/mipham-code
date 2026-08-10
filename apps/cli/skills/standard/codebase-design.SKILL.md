---
name: codebase-design
description: Deep module design principles for designing or improving module interfaces. Use when designing a new module, refactoring an existing one, or finding deepening opportunities in the codebase.
version: 1.0.0
user-invocable: true
allowed-tools:
  - Read
  - Glob
  - Grep
  - Edit
  - Write
---

# Codebase Design — Deep Module Principles

Based on John Ousterhout's "A Philosophy of Software Design." The core idea: the greatest single factor in software complexity is the depth of modules — how much functionality they provide relative to the size of their interface.

## When to Use

- Designing a new module, API, or component
- Reviewing existing code for design quality
- Deciding where to split or join modules
- User asks: "is this well-designed?", "where should this go?", "how should I structure this?"

---

## Core Concepts

### Deep vs Shallow Modules

```
Deep Module (good):            Shallow Module (bad):
┌─────────────────┐            ┌─────────────────┐
│ small interface  │            │ large interface  │
│ ┌─────────────┐ │            │ (many params,    │
│ │             │ │            │  complex setup)  │
│ │   large     │ │            ├─────────────────┤
│ │ implementation│            │ small            │
│ │             │ │            │ implementation   │
│ └─────────────┘ │            │ (just passes     │
└─────────────────┘            │  through)        │
                               └─────────────────┘
```

**Deep**: Unix file I/O — 5 syscalls (`open`, `read`, `write`, `lseek`, `close`), incredibly powerful implementation.

**Shallow**: A function that takes 12 parameters, validates 3 of them, then calls another function. Interface cost > implementation value.

### The Rule of Deep Modules

> The interface should be as small as possible while providing as much functionality as possible.

- **Cost** = interface complexity (parameters, configuration, setup required)
- **Benefit** = functionality provided (what the caller no longer needs to worry about)
- **Depth** = Benefit / Cost

---

## The 5 Design Checks

When evaluating a module design, run through these:

### Check 1: Interface Size

Count the effective parameters:
- Required parameters + optional parameters with non-trivial defaults
- Configuration methods that MUST be called before use
- Implicit dependencies (global state, env vars, singletons)

**Red flag**: > 4 effective parameters → the module may be too shallow.

**Fix**: Bundle related parameters into a config object. Or split the module.

### Check 2: Information Hiding

Does the module expose information that callers don't need?
- Internal data structures leaked through the interface
- Implementation details exposed via parameter types
- Error types that reveal internal architecture

**Red flag**: Callers import types they don't use directly.

**Fix**: Define a public API type layer. Return opaque handles instead of raw data.

### Check 3: Abstraction Quality

Does the module represent a single, coherent idea?
- Can you describe what it does in one sentence without "and"?
- Would a new team member guess where to find this functionality?
- If you remove the module, does exactly one concept go missing?

**Red flag**: Module name contains "and", "Utils", "Common", "Helpers".

**Fix**: Split by concept. `UserService` + `EmailService` instead of `UserAndEmailUtils`.

### Check 4: General-Purpose vs Special-Purpose

Is the module solving the general case or a specific use case?
- Would the interface work if requirements changed slightly?
- Are there hardcoded assumptions that could be parameters?
- Is the module useful in contexts other than its creator imagined?

**Red flag**: Module only works for one specific call site.

**Fix**: Make the specific case a thin wrapper around the general case. The general module is deep; the wrapper is shallow (and that's fine — wrappers are allowed to be shallow).

### Check 5: Seam Placement

Where you split modules matters as much as what they do.
- Does the split happen at a natural boundary?
- Are there circular dependencies across the seam?
- Can each side be tested independently?

**Red flag**: Circular imports, or modules that are always imported together.

**Fix**: Use dependency inversion. Define interfaces at the seam, not implementations.

---

## Finding Deepening Opportunities

Scan the codebase for these patterns:

### Shallow Pass-Through
```typescript
// Shallow — just delegates with no added value
function getUser(id: string) {
  return db.findUser(id)
}

// Deep — handles errors, caching, authorization in one call
function getUser(id: string, ctx: RequestContext) {
  const cached = cache.get(`user:${id}`)
  if (cached) return cached
  ctx.auth.assertCanRead('user', id)
  const user = db.findUser(id)
  if (!user) throw new NotFoundError('User', id)
  cache.set(`user:${id}`, user)
  return user
}
```

### Temporal Decomposition
When a module's methods must be called in a specific order, the interface is too wide.
```typescript
// Shallow — caller manages lifecycle
const conn = new Connection()
conn.open()
conn.authenticate(token)
conn.send(data)
conn.close()

// Deep — module manages lifecycle
const conn = await Connection.create(token)
conn.send(data)
// clean up automatically
```

### Overexposure
When internal types leak through the public API:
```typescript
// Shallow — exposes ORM internals
interface UserService {
  findUser(id: string): Promise<PrismaUser | null>  // ❌ PrismaUser is internal
}

// Deep — owns its types
interface UserService {
  findUser(id: string): Promise<User | null>  // ✅ User is a domain type
}
```

---

## Integration With Mipham Code

- **code-review**: This skill fills the architecture dimension that code-review's 7 dimensions don't cover. Use `/code-review` for correctness/security/perf; use `/codebase-design` for interface depth/abstraction quality/seam placement.
- **domain-modeling**: Good domain modeling makes deep modules easier — the CONTEXT.md glossary defines the concepts that modules should represent.
- **Critical Thinking Layer**: The counter-example search applies directly: "what would break if I changed the implementation of this module?"
