---
name: security-review
description: Security audit skill — vulnerability scanning, OWASP Top 10, secrets detection, supply chain analysis, and compliance checking
version: 1.0.0
---

# Security Review

Comprehensive security audit for codebases. Covers vulnerability detection, compliance, and hardening recommendations.

## Audit Checklist

### 1. Secrets & Credentials
- [ ] No hardcoded API keys, tokens, or passwords in source files
- [ ] `.env` and `*.pem` files in `.gitignore`
- [ ] API keys use environment variables or secret managers
- [ ] No credentials in git history (check `git log -p`)
- [ ] CI/CD secrets stored securely (not in workflow files)

### 2. OWASP Top 10
- [ ] **Injection**: SQL, NoSQL, OS command, LDAP injection points
- [ ] **Broken Authentication**: Weak password policies, missing MFA
- [ ] **Sensitive Data Exposure**: Unencrypted PII, missing TLS
- [ ] **XXE**: XML external entity processing
- [ ] **Broken Access Control**: Missing authorization checks
- [ ] **Security Misconfiguration**: Default credentials, verbose errors
- [ ] **XSS**: Reflected, stored, DOM-based cross-site scripting
- [ ] **Insecure Deserialization**: Untrusted data deserialization
- [ ] **Using Vulnerable Components**: Outdated dependencies with CVEs
- [ ] **Insufficient Logging**: Missing audit trails for auth events

### 3. Supply Chain
- [ ] All dependencies have known licenses (no copyleft/GPL)
- [ ] No dependencies with critical CVEs
- [ ] Lock files committed (pnpm-lock.yaml, package-lock.json)
- [ ] Dependency update policy in place
- [ ] SBOM (Software Bill of Materials) available

### 4. Network & API Security
- [ ] TLS 1.3 enforced for all external communications
- [ ] API endpoints have rate limiting
- [ ] CORS configured with explicit origins (not `*`)
- [ ] SSRF protections in place (URL validation, IP filtering)
- [ ] WebSocket connections use WSS
- [ ] GraphQL endpoints have query depth limits

### 5. File System & Path Security
- [ ] Path traversal protections (no `../../../etc/passwd`)
- [ ] File upload validation (type, size, content inspection)
- [ ] Symlink attacks prevented
- [ ] Sensitive directories blocked (`/etc`, `/proc`, `/sys`)
- [ ] Temporary files cleaned up after use

### 6. Code-Level Security
- [ ] No `eval()` or `Function()` with user input
- [ ] No `child_process.exec()` with unsanitized input
- [ ] Regex patterns safe from ReDoS
- [ ] Prototype pollution prevented
- [ ] No `dangerouslySetInnerHTML` without sanitization (React)
- [ ] SQL queries use parameterized statements

### 7. Authentication & Sessions
- [ ] Passwords hashed with bcrypt/argon2 (not MD5/SHA1)
- [ ] Session tokens use `httpOnly`, `secure`, `SameSite=Strict`
- [ ] JWT tokens have reasonable expiration
- [ ] Account lockout after failed attempts
- [ ] Password reset tokens expire and are single-use

### 8. Data Protection
- [ ] PII data encrypted at rest (AES-256-GCM)
- [ ] Data encrypted in transit (TLS 1.3)
- [ ] Logs do not contain sensitive data
- [ ] Database backups encrypted
- [ ] Data retention policies defined

### 9. Infrastructure
- [ ] Infrastructure as Code (Terraform/Pulumi) used
- [ ] Cloud resources not publicly exposed unless intended
- [ ] Security groups / firewalls restrict inbound traffic
- [ ] Container images scanned for vulnerabilities
- [ ] Kubernetes pods run as non-root

### 10. Logging & Monitoring
- [ ] Authentication events logged
- [ ] Failed access attempts logged and alerted
- [ ] Structured logging format (JSON)
- [ ] No PII in log messages
- [ ] Alert thresholds configured for critical events

## Report Format

```
Security Review Report
======================
Date: YYYY-MM-DD
Severity: Critical | High | Medium | Low

Finding #N: [Title]
Severity: Critical/High/Medium/Low
Location: file:line
Description: [What was found]
Risk: [What could happen]
Fix: [How to resolve]
```

## Compliance Standards

- OWASP ASVS Level 2
- PCI DSS (if handling payment data)
- GDPR (if handling EU personal data)
- SOC 2 Type II
- ISO 27001
