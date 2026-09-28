#!/usr/bin/env python3
"""
Guard for 'npm ci': runs only if package.json and package-lock.json are
unchanged from HEAD. This allows agents to run 'npm ci' to sync lockfile
changes without exposing an unreviewed dependency bump.

Exit 0 if install succeeds or no install was needed.
Exit 1 if package files were changed (requires human review before install).
Exit 1 if 'npm ci' fails.
"""

import subprocess
import sys
from pathlib import Path


def main() -> int:
    repo_root = Path(__file__).parent.parent

    # Files that must be unchanged from HEAD for a safe install.
    guard_files = [
        repo_root / "package.json",
        repo_root / "package-lock.json",
        repo_root / "frontend" / "package.json",
    ]

    # Check if any guard file has local modifications.
    result = subprocess.run(
        ["git", "status", "--porcelain", "--"] + [str(f) for f in guard_files],
        cwd=repo_root,
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        print(f"error: git status failed: {result.stderr}", file=sys.stderr)
        return 1

    if result.stdout.strip():
        print(
            "error: package.json or package-lock.json have local changes.\n"
            "Review them and commit before running 'npm ci'.\n"
            f"Changed files:\n{result.stdout}",
            file=sys.stderr,
        )
        return 1

    # All guard files are clean; safe to run npm ci.
    # On Windows, shell=True is needed to resolve npm from PATH.
    result = subprocess.run(["npm", "ci"], cwd=repo_root, shell=sys.platform == "win32")
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
