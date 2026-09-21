# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

The repository is pre-implementation: the only source of truth is `LOCAL_DECISION_HUB_IMPLEMENTATION_PLAN.md`. Read the relevant section of it before starting any task. Work proceeds strictly in the plan's task order (§17, Phase 0 → 6); the Windows packaging spike (Task 0.3) is intentionally early. One task per change, commit after each completed task. Update this file as real commands and structure come into existence.

"Local Decision Hub" is a working title. Keep the product name, executable names, package slug, app-data directory, and protocol version centralized (e.g. in `settings.py`) so a rename is not a repo-wide edit.

## Commands (planned — verify they exist before relying on them)

- `py scripts/verify.py` — the single supported local/CI check. Runs, fail-fast: formatting → Python lint + type check → Python tests + coverage → frontend lint/typecheck/tests/build → generated-contract drift → offline secret/dependency checks. Must pass before every commit once it exists. Never remove a check from it to make a task pass.
- `py scripts/verify.py --real-model` — opt-in tests against downloaded Laya weights.
- `py scripts/verify.py --package-windows` — opt-in PyInstaller/installer smoke tests.
- Python deps are managed with `uv` (`uv.lock`); frontend with npm (`package-lock.json`).
- The plan does not pick a Python formatter. When creating `pyproject.toml`, choose `ruff format` or `black`, wire it into `verify.py`, and record the choice here.

## Stack

Python 3.12, FastAPI, Pydantic v2, YAML recipes (safe loading), stdlib SQLite, official MCP Python SDK (stdio). Frontend: React + TypeScript + Vite, built to static assets served by FastAPI, no CDN/external assets. Packaging: PyInstaller `--onedir` + Inno Setup, user-scoped, Windows 11 x64, CPU-only. Model weights are downloaded at first run, never bundled.

## Architecture

```
MCP client --stdio--> local-decision-mcp (thin bridge) --HTTP+token--> Local Decision Service <--HTTP+token-- browser UI
                                                                            |
                                                  recipe store (YAML) / model manager / history (SQLite, opt-in)
                                                                            |
                                                                       LayaAdapter --> laya package --> local weights
```

Invariants that span modules:

- **Only `backend/src/local_decision_hub/laya_adapter/` may import `laya`.** Everything else talks to the `DecisionEngine` protocol (`ensure_model`, `predict`, `unload`). Upstream objects must never leak into domain models, the recipe schema, or the result envelope. Upstream mismatches → add a failing compatibility test, fix the adapter, update `docs/architecture/laya-compatibility.md`.
- **The backend owns everything** (recipes, models, policy, history, Laya lifecycle) and must work without UI or MCP. The UI uses the same documented `/v1` API as the tests; it never touches the filesystem directly.
- **The MCP bridge never loads a model.** It forwards to the running service, auto-starting it (argument array, `shell=False`) and polling `/health/ready` if needed. stdout is protocol-only; logs go to stderr.
- **Single backend instance** owns the model and state; UI and MCP discover the same endpoint and token from app state under `%LOCALAPPDATA%/<slug>/` (never the install dir).
- **Stable product-owned contracts**: recipe `schema_version: 1` (§9.1) and the decision result envelope with `contract_version` (§9.3). `review` (e.g. `needs_review`) comes from the review policy + warnings and is shown separately from raw probability — it is not a correctness claim.
- Inference runs off the event loop through a single worker with a bounded queue (`429` when full); model loading is serialized.
- Default model profile is `typed-decisions`; `english`, `multilingual`, `auto` are advanced. Every result reports the actual checkpoint and pinned revision.

## Testing rules

- Domain tests must not import Laya or FastAPI.
- Ordinary tests and PR CI use the deterministic fake engine and a fake model artifact source — no network, no Hugging Face, no real weights.
- Never weaken, skip, or delete tests to get a passing build.

## Hard constraints (stop and ask before changing)

- Bind only to `127.0.0.1`; reject `0.0.0.0`. Bearer token + Host/Origin validation + restrictive CORS + CSP.
- Decision input is plain text or bounded JSON only — no file paths, URLs, or attachments (in API or MCP). No generic shell/HTTP/filesystem MCP tools.
- Recipes: strict (unknown fields rejected), no code/templates/URLs/env expansion/paths; IDs are lowercase kebab-case mapped to paths by the store (atomic writes, traversal/symlink protection).
- Never log request bodies, decision inputs/answers, recipe content, tokens, or MCP payloads.
- History off by default; no telemetry, cloud inference, connectors, or automatic downstream actions.
- Pin Laya version and model revisions (no floating branches); `trust_remote_code=False`.
- Never copy Laya source, clone its history, or add it as a remote. Credit it as "Powered by Laya… developed by Convai Innovations" without implying endorsement; don't use Laya branding as the product name.
- Don't make accuracy/calibration/privacy/offline claims the tests and architecture don't support — external AI clients (Claude, Copilot) are not offline.
- Ask for a product decision before anything that alters the trust boundary, license obligations, persistence defaults, or V1 non-goals (§4).
