"""Single supported verification entry point for local development and CI.

Usage:
    py scripts/verify.py                    # ordinary checks (no network, no weights)
    py scripts/verify.py --real-model       # also run tests against real Laya weights
    py scripts/verify.py --package-windows  # also build and smoke-test the Windows package

The script itself only needs the standard library. Every tool runs inside the
locked project environment through ``uv run --frozen``.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY_PATHS = ["backend", "mcp", "scripts"]
COVERAGE_MIN = 85


@dataclass(frozen=True)
class Step:
    name: str
    argv: Sequence[str]
    when: bool = True


def _uv(*args: str) -> list[str]:
    return ["uv", "run", "--frozen", *args]


def _npm() -> str:
    # npm is a .cmd shim on Windows; resolve it so no shell is needed.
    found = shutil.which("npm")
    if found is None:
        raise SystemExit("verify: npm not found on PATH")
    return found


def _existing(paths: Sequence[str]) -> list[str]:
    return [p for p in paths if (ROOT / p).exists()]


def build_steps(args: argparse.Namespace) -> list[Step]:
    py_paths = _existing(PY_PATHS)
    frontend = (ROOT / "frontend" / "package.json").exists()
    npm = _npm()
    pytest_args = [
        "python",
        "-m",
        "pytest",
        "--cov",
        "--cov-report=term",
        f"--cov-fail-under={COVERAGE_MIN}",
    ]
    if args.real_model:
        pytest_args.append("--real-model")
    return [
        Step("format (black --check)", _uv("python", "-m", "black", "--check", *py_paths)),
        Step("lint (ruff)", _uv("python", "-m", "ruff", "check", *py_paths)),
        Step("types (pyright)", [npm, "exec", "--", "pyright"]),
        Step("python tests + coverage", _uv(*pytest_args)),
        Step("frontend lint", [npm, "run", "--workspace", "frontend", "lint"], frontend),
        Step("frontend types", [npm, "run", "--workspace", "frontend", "typecheck"], frontend),
        Step("frontend tests", [npm, "run", "--workspace", "frontend", "test"], frontend),
        Step("frontend build", [npm, "run", "--workspace", "frontend", "build"], frontend),
        Step(
            "contract drift",
            _uv("python", "scripts/check_contracts.py"),
            (ROOT / "contracts").exists(),
        ),
        Step("secret scan", _uv("python", "scripts/scan_secrets.py")),
        Step(
            "windows package",
            _uv("python", "packaging/windows/build.py", "--smoke"),
            args.package_windows,
        ),
    ]


def run(steps: Sequence[Step]) -> int:
    results: list[tuple[str, str, float]] = []
    env = {**os.environ, "PYTHONUTF8": "1"}
    for step in steps:
        if not step.when:
            results.append((step.name, "skipped", 0.0))
            continue
        print(f"\n=== {step.name} ===", flush=True)
        started = time.perf_counter()
        code = subprocess.call(list(step.argv), cwd=ROOT, env=env)
        elapsed = time.perf_counter() - started
        if code != 0:
            results.append((step.name, f"FAILED (exit {code})", elapsed))
            _summary(results)
            return code
        results.append((step.name, "ok", elapsed))
    _summary(results)
    return 0


def _summary(results: Sequence[tuple[str, str, float]]) -> None:
    print("\n=== verify summary ===")
    for name, status, elapsed in results:
        print(f"  {status:<18} {elapsed:6.1f}s  {name}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the OpenReflex verification suite.")
    parser.add_argument("--real-model", action="store_true", help="run real-weight tests")
    parser.add_argument("--package-windows", action="store_true", help="build Windows package")
    args = parser.parse_args(argv)
    return run(build_steps(args))


if __name__ == "__main__":
    sys.exit(main())
