"""Build the complete Windows ``--onedir`` payload and optionally smoke-test it.

    uv run python release/windows/build.py            # build only
    uv run python release/windows/build.py --smoke    # build, then run checks
    uv run python release/windows/build.py --release  # also require every PE file signed

Output goes to ``release/windows/output/`` (git-ignored). The payload is one
folder holding ``openreflex-service.exe`` and ``openreflex-mcp.exe`` (sharing
one ``_internal`` runtime), the production UI in ``ui/``, the license, and the
third-party notices. It never contains model weights. See ``smoke.py`` for
what the smoke test checks.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUTPUT = HERE / "output"
FRONTEND_DIST = ROOT / "frontend" / "dist"
NOTICES = ("LICENSE", "THIRD_PARTY_NOTICES.md")
WEIGHT_SUFFIXES = (".safetensors", ".bin", ".pt", ".pth", ".ckpt", ".gguf", ".onnx")
sys.path.insert(0, str(ROOT / "backend" / "src"))
sys.path.insert(0, str(HERE))

import signatures  # noqa: E402
import smoke  # noqa: E402

from openreflex.identity import PRODUCT_NAME  # noqa: E402


def build_frontend() -> None:
    npm = shutil.which("npm")
    if npm is None:
        raise SystemExit("build: npm not found on PATH (needed to build the UI)")
    subprocess.run([npm, "run", "--workspace", "frontend", "build"], cwd=ROOT, check=True)
    if not (FRONTEND_DIST / "index.html").is_file():
        raise SystemExit("build: the frontend build produced no index.html")


def build() -> Path:
    build_frontend()
    dist = OUTPUT / "dist"
    shutil.rmtree(dist, ignore_errors=True)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--distpath",
            str(dist),
            "--workpath",
            str(OUTPUT / "work"),
            str(HERE / "openreflex.spec"),
        ],
        check=True,
    )
    app_dir = dist / PRODUCT_NAME
    # Beside the executables, where the frozen service's UI discovery
    # (``<install>/ui``) and a person browsing the install folder find them.
    shutil.copytree(FRONTEND_DIST, app_dir / "ui")
    for name in NOTICES:
        shutil.copy2(ROOT / name, app_dir / name)
    check_payload(app_dir)
    return app_dir


def check_payload(app_dir: Path) -> None:
    weights = [p for p in app_dir.rglob("*") if p.suffix.lower() in WEIGHT_SUFFIXES]
    if weights:
        raise SystemExit(f"build: model weights must never be bundled: {weights}")
    missing = [name for name in (*NOTICES, "ui/index.html") if not (app_dir / name).is_file()]
    if missing:
        raise SystemExit(f"build: the payload is missing {missing}")


def check_signatures(app_dir: Path, release: bool) -> int:
    """Write the PE signature inventory; in release mode fail on any unsigned file."""
    argv = [str(app_dir), "--out", str(OUTPUT / "signature-inventory.json")]
    return signatures.main([*argv, "--release"] if release else argv)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--smoke", action="store_true", help="smoke-test the built package")
    parser.add_argument("--release", action="store_true", help="fail on unsigned PE files")
    parser.add_argument("--skip-build", action="store_true", help="reuse the existing build")
    args = parser.parse_args()
    app_dir = OUTPUT / "dist" / PRODUCT_NAME if args.skip_build else build()
    if args.skip_build:
        check_payload(app_dir)
    if args.smoke or args.release:
        print(json.dumps(smoke.run_smoke(app_dir), indent=2))
    return check_signatures(app_dir, args.release)


if __name__ == "__main__":
    sys.exit(main())
