# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Mipham Code, please **do not** open a public issue.

Instead, report it privately to the security team. We will acknowledge your report within 48 hours and provide a timeline for resolution.

## Security Model

Mipham Code follows the security requirements defined in One Mipham Corporation's CLAUDE.md:

### Data Encryption

- **TLS 1.3** for all data in transit
- **AES-256-GCM** for data at rest
- All API communication is encrypted end-to-end

### Credential Management

- No hardcoded credentials in code, logs, or configuration files
- API keys resolved from environment variables only (`${ENV_VAR}` pattern)
- Credentials never stored in git history

### Dependency Security

- All third-party dependencies undergo license compliance checks
- No copyleft/GPL dependencies permitted
- Regular dependency vulnerability scanning

#### Accepted advisories

`pnpm audit --audit-level=high` runs in CI and is expected to be clean. An advisory is accepted only
when it cannot be fixed by upgrading, and only as a **scoped exemption tracked by GHSA id** in the
root `package.json` (`pnpm.auditConfig.ignoreGhsas`). Every other advisory — dev tree included —
still fails the job.

| GHSA                  | Package                                                               | Why accepted                                                                                                                                                                                                                                                                                                                                                                                                                         | Revisit trigger                                                                   |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `GHSA-vfj7-8cjw-p6xm` | `braces` — high, CWE-674, stack exhaustion via deeply nested patterns | **No patched version exists**: `braces@3.0.3` is still `latest`, and the advisory lists `first_patched_version: None`. It is reachable only from `apps/web`'s **devDependency** `tailwindcss` → `chokidar` / `fast-glob` / `micromatch`, where the glob patterns are our own build config rather than caller input. `pnpm --filter @miphamai/cli why braces` is empty: the CLI runtime tree that ships to users does not contain it. | Remove the entry as soon as any `braces` release outside `<= 3.0.3` is published. |

### AI Security

- All AI features undergo prompt injection testing before release
- Adversarial robustness testing for model inputs
- Content safety filtering for harmful outputs
- Rate limiting and abuse detection on API endpoints

## Supported Versions

| Version | Supported             |
| ------- | --------------------- |
| 0.2.x   | ✅ Active development |
| < 0.1   | ❌ Unreleased         |

## Security Best Practices for Users

1. **Never share your API keys** or commit them to repositories
2. **Use environment variables** for all secrets
3. **Review tool permissions** before granting auto-approval
4. **Audit MCP server connections** before enabling them
5. **Keep Mipham Code updated** to the latest version

## Threat Model

The primary threat vectors for an AI coding terminal:

1. **Prompt Injection**: Malicious instructions embedded in code or documents
2. **Tool Abuse**: Unauthorized file system or network access via tools
3. **Data Exfiltration**: Sensitive data leaking through model API calls
4. **Supply Chain**: Compromised dependencies or MCP servers

Our defense-in-depth approach:

- Permission system with auto/ask/bypass levels per tool
- Hook engine for PreToolUse/PostToolUse validation
- Context manager prevents data leakage through compaction
- Instruction file privacy levels (public/project/private)
