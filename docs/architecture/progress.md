# Implementation progress and plan deviations

Tracks `LOCAL_DECISION_HUB_IMPLEMENTATION_PLAN.md` §17.

## Deviations from the plan (owner-approved)

| Plan says | Actual | Reason |
| --- | --- | --- |
| Working title "Local Decision Hub" | **OpenReflex** (`openreflex` package) | Owner decision, 2026-09-21 |
| Python 3.12 | Python ≥3.12. Developed on system 3.14, and tooling targets 3.12 syntax. | Windows Application Control blocks uv-managed CPython builds on the dev machine |
| Type checks (tool unspecified) | pyright via npm | mypy's compiled `librt` DLLs are blocked by Application Control |
| Formatter (unspecified) | black | Owner decision |
| Task 0.3 as one task | Split into 0.3a–0.3d (below) | Owner decision. Application Control blocks unsigned native DLLs such as torch |
| `packaging/windows/` | `release/windows/` | The top-level `packaging/` dir shadowed PyPI `packaging` (transformers import failed under pytest) |
| Real-model tests on the dev machine | Run under Docker (Linux) | torch DLLs are blocked natively. Native Windows real-model support is still a release blocker. |

## Task status

| Task | Status | Notes |
| --- | --- | --- |
| 0.1 Independent repository | done | |
| 0.2 Upstream compatibility | done (Linux) | Real-model probe run under Docker. Native Windows run is tracked in 0.3d. Checkpoint license is a release blocker. |
| 0.3a Fake-engine Windows packaging | done | Onedir build + smoke locally and in CI. Smoke decision added with 2.1. See windows-packaging.md |
| 0.3b Native PE/DLL signature inventory | done | `signatures.py`, and `build.py --release` fails on any unsigned/unverifiable PE file. The current payload is blocked by the unsigned launcher. |
| 0.3c Complete release-payload signing | blocked on owner | Needs a code-signing certificate (or Trusted Signing account). Every shipped PE file must be signed, not only the installer/launcher. |
| 0.3d Clean-machine Application Control smoke test | blocked on owner | Needs a clean Windows 11 VM with Application Control enforced, and signed output from 0.3c. Release blocker. Can't be satisfied by WSL2/Linux or an unsigned dev build. |
| 1.1 Domain models | done | JSON Schemas are in `contracts/`, and drift is checked by verify |
| 1.2 Recipe storage | done | Symlink tests skip on unprivileged Windows and are verified on Linux (Docker, CI). Examples ship as package data in `openreflex/recipes/examples/` (the plan has `recipes/examples/` at the top level). |
| 2.1 Fake engine + service contract | done | Policy in `domain/policy.py`. Fake engine markers force each state. The packaged smoke test runs a fake decision. |
| 2.2 LayaAdapter | done (Linux) | 33 host contract tests plus 7 real-model tests in Docker. Top-level `packaging/` was renamed to `release/` because it shadowed the PyPI `packaging` module that transformers imports. |
| 2.3 Model manager | done | Stdlib HTTPS source fetches only catalog files at the pinned revision. Resumable, and every file is verified (LFS sha256 or git blob SHA-1). OS file locks, damaged state, remove. Real hub checked for small files in Docker. |
| 3.1 FastAPI service | done | All plan endpoints, plus recipe import/export, model verify, preferences, and clear history (needed by the UI). Security middleware covers Host, Origin, token, body limit, headers, and content-free logs. `?confirm=` guards deletes. |
| 3.2 Lifecycle / single instance | todo | |
| 4.1 MCP bridge | todo | |
| 4.2 Client config generation | todo | |
| 5.1 Setup/status screens | todo | |
| 5.2 Recipe/decision screens | todo | |
| 6.1 Windows installer | todo | |
| 6.2 Security/privacy/license review | todo | |
| 6.3 Non-developer usability test | todo | Needs a human participant |
