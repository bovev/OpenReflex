---
task: 11
status: todo
depends_on: [10]
rework_rounds: 0
---

# Automate security and privacy release checks

## Goal
Add reproducible automated checks for dependency risk, static security issues, localhost attacks, secret leakage, and production logging/privacy invariants.

## Scope
Security scripts and policy, CI, backend/MCP/frontend/release security tests, and factual security/privacy documentation corrections. Legal license disposition is separate.

## Do
- Add pinned Python and npm dependency-vulnerability checks with a documented severity gate. Any temporary advisory exception must name the package/advisory, rationale, owner, and expiry.
- Retain ruff security rules, pyright, frontend lint/type checks, secret scanning, and existing tests; do not replace or weaken them.
- Expand localhost attack tests for Host/Origin spoofing, restrictive CORS/CSP, unauthenticated connection metadata, oversized/chunked bodies, traversal/symlink attempts, malicious YAML, and static-route auth boundaries.
- Add regression tests proving path/URL-looking decision strings remain inert and no generic shell, HTTP, upload, attachment, or filesystem source surface appears in API or MCP schemas.
- Capture production logs in adversarial tests and assert that tokens, request bodies, recipe content, decision inputs/answers, MCP payloads, and deliberately planted canary secrets never appear.
- Check frontend production output for external URLs/assets, source-map leakage, inline executable content disallowed by CSP, and accidental secret/config embedding.
- Add release-payload checks for writable install-tree assumptions, unexpected executables, and signature-inventory completeness without pretending unsigned files are acceptable for release.
- Provide one documented automated security-review command suitable for CI and include it in release gating without making ordinary verification depend on real weights.

## Acceptance criteria
- [ ] Automated checks fail on critical/high dependency findings unless a current, fully documented exception exists.
- [ ] Attack tests cover the service, MCP schemas, frontend assets, and installer/payload boundaries.
- [ ] Canary request, recipe, decision, token, and MCP content is absent from captured production logs and diagnostic exports.
- [ ] The loopback-only, bearer-token, Host/Origin, CSP, no-telemetry, and history-off defaults remain enforced.
- [ ] No check is skipped or weakened because of Windows Application Control or unavailable real weights.
- [ ] `py scripts/verify.py` and the documented automated security-review command pass.

## Out of scope
- Penetration testing by a human or third party.
- Accepting security risk on behalf of the owner.
- Signing, checkpoint-license approval, or legal review.
