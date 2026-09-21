# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately through GitHub's **Report a vulnerability** button (Security → Advisories) on this repository.

Please include:

- the affected version or commit;
- steps to reproduce;
- the impact you believe it has.

We aim to acknowledge reports within 5 working days. We'll coordinate on disclosure timing once a fix is ready.

## Security model (V1)

- The local service listens only on `127.0.0.1` and requires a per-install bearer token.
- `Host` and `Origin` headers are validated to reduce DNS-rebinding and cross-site localhost attacks.
- Decision inputs are plain text or bounded JSON. OpenReflex never reads local files or fetches URLs on a caller's behalf.
- Recipes are data only: no code, templates, URLs, environment expansion, or file paths.
- Model repositories are loaded without executing remote code.
- Logs never contain request bodies, decision inputs or outputs, recipe content, or tokens.
- There is no telemetry.

Anything that breaks one of these properties is a security issue.
