# Contributing

## Prerequisites

- Windows 11 x64 (Linux works for everything except packaging)
- Python 3.12 or newer, installed system-wide. On machines with Windows Application Control, use the signed python.org / Python Install Manager interpreter. uv-managed interpreters may be blocked, so `pyproject.toml` sets `python-preference = "only-system"`.
- [uv](https://docs.astral.sh/uv/)
- Node.js 22 or newer with npm
- Docker, only for real-model compatibility tests

## Setup

```sh
uv sync
npm install
npm exec --workspace frontend -- playwright install chromium
```

The last command downloads the pinned Chromium build used by the browser tests (one-time, per Playwright version). The tests themselves make no network requests outside the local test service.

## Verify

```sh
py scripts/verify.py
```

This is the same command CI runs. Every commit must pass it. It runs formatting (black), lint (ruff), type checks (pyright), tests with a coverage floor, frontend checks (lint, types, unit tests, build, and browser tests against a local fake service), contract drift checks, and a secret scan. Tests never download model weights.

Useful subsets:

```sh
uv run python -m black .                    # format
uv run python -m pytest backend/tests/test_x.py::test_name
npm run --workspace frontend build && npm run --workspace frontend e2e   # browser suite
```

Opt-in, expensive checks:

```sh
py scripts/verify.py --real-model       # needs Laya + weights, see docs/architecture/laya-compatibility.md
py scripts/verify.py --package-windows  # builds and smoke-tests the Windows package
```

## Rules

- Laya is a dependency, not vendored code. Only `openreflex.laya_adapter` may import `laya`, and ruff enforces this.
- Don't weaken, skip, or delete tests to get a green build.
- Pin dependency versions and model revisions.
- Don't commit model weights, tokens, or user data.
