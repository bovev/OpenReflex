"""Build the Windows ``--onedir`` package and optionally smoke-test it.

    uv run python packaging/windows/build.py            # build only
    uv run python packaging/windows/build.py --smoke    # build, then run checks
    uv run python packaging/windows/build.py --release  # also require every PE file signed

Output goes to ``packaging/windows/output/`` (git-ignored). The smoke test runs
the frozen executable with an isolated data directory and checks that it
starts without system Python, finds its own files, writes only to the data
directory, and never modifies the install directory.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUTPUT = HERE / "output"
sys.path.insert(0, str(ROOT / "backend" / "src"))
sys.path.insert(0, str(HERE))

import signatures  # noqa: E402

from openreflex.identity import SERVICE_EXECUTABLE  # noqa: E402
from openreflex.paths import DATA_DIR_ENV  # noqa: E402


def build() -> Path:
    work = OUTPUT / "work"
    dist = OUTPUT / "dist"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--onedir",
            "--console",
            "--name",
            SERVICE_EXECUTABLE,
            "--paths",
            str(ROOT / "backend" / "src"),
            "--distpath",
            str(dist),
            "--workpath",
            str(work),
            "--specpath",
            str(work),
            "--collect-data",
            "openreflex",
            "--add-data",
            f"{ROOT / 'LICENSE'}{os.pathsep}.",
            "--add-data",
            f"{ROOT / 'THIRD_PARTY_NOTICES.md'}{os.pathsep}.",
            str(HERE / "entry_service.py"),
        ],
        check=True,
    )
    return dist / SERVICE_EXECUTABLE


def _snapshot(folder: Path) -> dict[str, tuple[int, int]]:
    return {
        str(p.relative_to(folder)): (p.stat().st_size, p.stat().st_mtime_ns)
        for p in folder.rglob("*")
        if p.is_file()
    }


def smoke(app_dir: Path) -> dict[str, Any]:
    exe = app_dir / f"{SERVICE_EXECUTABLE}.exe"
    if not exe.exists():
        exe = app_dir / SERVICE_EXECUTABLE
    before = _snapshot(app_dir)
    with tempfile.TemporaryDirectory(prefix="openreflex-smoke-") as tmp:
        data = Path(tmp) / "data"
        # Strip Python from the environment so the frozen app cannot lean on it.
        env = {
            k: v
            for k, v in os.environ.items()
            if not k.upper().startswith(("PYTHON", "VIRTUAL_ENV"))
        }
        env[DATA_DIR_ENV] = str(data)
        started = time.perf_counter()
        proc = subprocess.run(
            [str(exe), "smoke"], env=env, capture_output=True, text=True, timeout=120
        )
        cold_start_s = time.perf_counter() - started
        if proc.returncode != 0:
            raise SystemExit(f"smoke failed ({proc.returncode}):\n{proc.stdout}\n{proc.stderr}")
        report = json.loads(proc.stdout)
        if not report["frozen"]:
            raise SystemExit("smoke: executable does not report itself as frozen")
        if Path(report["install_dir"]).resolve() != app_dir.resolve():
            raise SystemExit(f"smoke: wrong install dir {report['install_dir']}")
        if Path(report["data_dir"]).resolve() != data.resolve() or not data.is_dir():
            raise SystemExit("smoke: data directory was not used")
        if report["decision"]["status"] != "completed" or len(report["examples_seeded"]) != 4:
            raise SystemExit(f"smoke: fake decision failed: {report['decision']}")
    if _snapshot(app_dir) != before:
        raise SystemExit("smoke: the install directory was modified at runtime")
    size = sum(p.stat().st_size for p in app_dir.rglob("*") if p.is_file())
    return {
        "decision": report["decision"],
        "cold_start_s": round(cold_start_s, 2),
        "installed_bytes": size,
        "files": sum(1 for p in app_dir.rglob("*") if p.is_file()),
    }


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
    app_dir = OUTPUT / "dist" / SERVICE_EXECUTABLE if args.skip_build else build()
    if args.smoke or args.release:
        print(json.dumps(smoke(app_dir), indent=2))
    return check_signatures(app_dir, args.release)


if __name__ == "__main__":
    sys.exit(main())
