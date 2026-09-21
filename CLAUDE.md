# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

Implementation follows `LOCAL_DECISION_HUB_IMPLEMENTATION_PLAN.md` in its task order (§17, Phase 0 → 6). Read the relevant section before starting a task. Keep each change to one task and commit after each completed task. Progress and deviations from the plan are tracked in `docs/architecture/progress.md`.

The product is named **OpenReflex** (the plan's "Local Decision Hub" is superseded). The package is `openreflex`. Naming (product name, executable names, app-data dir, protocol version) lives in one identity module, so don't hard-code it elsewhere.

## Dev machine constraints (Windows Application Control)

The dev machine enforces Windows Application Control. It blocks torch DLLs, uv-managed CPython, and mypy's compiled DLLs. **Never disable or bypass it.**
- Use the system Python 3.14 (`[tool.uv] python-preference = "only-system"`). Code must stay compatible with 3.12 (`requires-python >=3.12`, black/ruff/pyright target 3.12).
- Type checking uses pyright (npm), not mypy.
- Laya/torch can't run natively here. Real-model compatibility tests run under Docker. Everything else uses the deterministic fake engine.
- Native Windows real-model support stays a release blocker. Task 0.3 is split into: fake-engine packaging → native PE/DLL signature inventory → complete release-payload signing → clean-machine Application Control smoke test. Never mark it done based on WSL2/Linux, an unsigned build, or signing only the installer/launcher.

## Commands

- `py scripts/verify.py` — the single supported local/CI check (stdlib-only script, runs tools through `uv run --frozen`). Fail-fast order: black --check → ruff → pyright → pytest with coverage floor → frontend lint/typecheck/test/build (once `frontend/` exists) → contract drift (once `contracts/` exists) → secret scan. Must pass before every commit. Never remove a check to make a task pass.
- `py scripts/verify.py --real-model` / `--package-windows` — opt-in, expensive.
- Format: `uv run python -m black .` (black is the formatter; system `py -m black` is blocked by App Control, so run it through the venv).
- Single test: `uv run python -m pytest backend/tests/test_x.py::test_name`
- Setup: `uv sync` and `npm install` (root npm workspace holds pyright, and later the frontend).
- Tests marked `@pytest.mark.real_model` are skipped unless `--real-model` is given.

## Stack

Python ≥3.12, FastAPI, Pydantic v2, YAML recipes (safe loading), stdlib SQLite, official MCP Python SDK (stdio). Frontend: React + TypeScript + Vite, built to static assets served by FastAPI, no CDN/external assets. Packaging: PyInstaller `--onedir` + Inno Setup, user-scoped, Windows 11 x64, CPU-only. Model weights are downloaded at first run, never bundled. `laya` is an optional extra (`openreflex[laya]`), so ordinary environments don't install torch.

## Architecture

```
MCP client --stdio--> local-decision-mcp (thin bridge) --HTTP+token--> Local Decision Service <--HTTP+token-- browser UI
                                                                            |
                                                  recipe store (YAML) / model manager / history (SQLite, opt-in)
                                                                            |
                                                                       LayaAdapter --> laya package --> local weights
```

Invariants that span modules:

- **Only `backend/src/openreflex/laya_adapter/` may import `laya`** (ruff TID251 enforces it). Everything else talks to the `DecisionEngine` protocol (`ensure_model`, `predict`, `unload`). Upstream objects must never leak into domain models, the recipe schema, or the result envelope. Upstream mismatches → add a failing compatibility test, fix the adapter, update `docs/architecture/laya-compatibility.md`.
- **The backend owns everything** (recipes, models, policy, history, Laya lifecycle) and must work without UI or MCP. The UI uses the same documented `/v1` API as the tests; it never touches the filesystem directly.
- **The MCP bridge never loads a model.** It forwards to the running service, auto-starting it (argument array, `shell=False`) and polling `/health/ready` if needed. stdout is protocol-only; logs go to stderr.
- **Single backend instance** owns the model and state; UI and MCP discover the same endpoint and token from app state under `%LOCALAPPDATA%/OpenReflex/` (never the install dir).
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
