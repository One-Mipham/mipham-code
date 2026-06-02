---
name: code-review
description: Code review automation for TypeScript, JavaScript, Python, Go, Swift, Kotlin
version: 1.0.0
---

# Code Review Skill

Analyzes PRs for complexity and risk, checks code quality for SOLID violations and code smells, generates review reports.

## Review Checklist
- Complexity analysis: identify high-complexity files
- Risk assessment: flag files most likely to contain bugs
- Code quality: SOLID violations, code smells
- Security: OWASP top 10 checks
- Performance: N+1 queries, memory leaks

## Output Format
Generate a review report with findings categorized by severity (critical, high, medium, low).
