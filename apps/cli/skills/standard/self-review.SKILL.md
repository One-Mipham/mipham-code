---
name: self-review
description: Self-review of staged or recently changed code — reuse, simplification, efficiency, and architectural alignment
version: 2.0.0
---

# Self Review

Review your own code changes before committing or merging. Focus on quality improvements, not bug hunting.

## When to Run

- Before committing changes
- After completing a feature or fix
- Before requesting a peer review
- As the final step before merging

## Review Passes

### Pass 1: Reuse

- Is there existing code that does the same thing?
- Are there utility functions or shared libraries you missed?
- Could this be solved with a standard library method?
- Are you reimplementing something the framework provides?

### Pass 2: Simplification

- Can a complex function be split into smaller, named functions?
- Are there unnecessary abstractions (interfaces with one impl, unused generics)?
- Can nested conditionals be flattened with early returns?
- Is there dead code, unused imports, or commented-out blocks?

### Pass 3: Efficiency

- Are you looping over data multiple times when once would suffice?
- Are large objects being copied unnecessarily?
- Could a synchronous operation be made async/non-blocking?
- Are regex patterns compiled once or on every call?

### Pass 4: Altitude (Architectural Alignment)

- Does this code belong where it is?
- Is it in the right layer (UI / business logic / data access)?
- Does it follow existing patterns in the codebase?
- Would a new developer understand where to find this?

## Output

After each pass, either:

- Apply the improvement directly (for clear wins)
- Note the observation with a recommendation (for trade-off decisions)

## Anti-Patterns

- ❌ Rewriting working code for style preference
- ❌ Adding abstractions "just in case"
- ❌ Changing code outside the scope of your changes
- ❌ "This could be a microservice" — no it couldn't
