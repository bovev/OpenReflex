"""Build the Linux compatibility image and run a command in it.

    py scripts/laya_compat/run.py probe [--profile typed-decisions]
    py scripts/laya_compat/run.py pytest   # real-model tests (--real-model)

Weights are cached in the ``openreflex-hf-cache`` Docker volume. This is the
only supported way to exercise real Laya weights on machines where Windows
Application Control blocks native torch; it does not stand in for native
Windows verification.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
IMAGE = "openreflex-laya-compat"
VOLUME = "openreflex-hf-cache"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["probe", "pytest"])
    parser.add_argument("--profile", default="typed-decisions")
    args = parser.parse_args()

    subprocess.run(
        ["docker", "build", "-q", "-t", IMAGE, str(ROOT / "docker" / "laya-compat")], check=True
    )
    if args.command == "probe":
        inner = [
            "python",
            "scripts/laya_compat/probe.py",
            "--profile",
            args.profile,
            "--out",
            f"backend/tests/fixtures/laya/{args.profile}.json",
        ]
    else:
        inner = [
            "sh",
            "-c",
            "pip install -q -c /tmp/constraints.txt -e . && python -m pytest --real-model -m real_model",
        ]
    docker = ["docker", "run", "--rm", "-v", f"{ROOT}:/repo", "-v", f"{VOLUME}:/hf-cache", IMAGE]
    return subprocess.call([*docker, *inner])


if __name__ == "__main__":
    sys.exit(main())
