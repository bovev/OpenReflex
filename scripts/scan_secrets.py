"""Offline secret scan over files that git tracks or would track.

This is a coarse safety net for the verification command, not a replacement
for the dedicated scanner that CI runs. A line can opt out with the marker
``secret-scan: allow`` when it intentionally contains a look-alike value.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ALLOW_MARKER = "secret-scan: allow"
MAX_BYTES = 2 * 1024 * 1024

PATTERNS: dict[str, re.Pattern[str]] = {
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY"),
    "AWS access key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),
    "Hugging Face token": re.compile(r"\bhf_[A-Za-z0-9]{30,}\b"),
    "Anthropic key": re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
    "OpenAI-style key": re.compile(r"\bsk-[A-Za-z0-9]{32,}\b"),
    "Slack token": re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
}


def candidate_files() -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    ).stdout
    return [ROOT / name for name in out.decode("utf-8").split("\0") if name]


def scan(path: Path) -> list[str]:
    try:
        if path.stat().st_size > MAX_BYTES:
            return []
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    findings: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        if ALLOW_MARKER in line:
            continue
        for label, pattern in PATTERNS.items():
            if pattern.search(line):
                findings.append(f"{path.relative_to(ROOT)}:{lineno}: possible {label}")
    return findings


def main() -> int:
    findings = [f for path in candidate_files() if path.is_file() for f in scan(path)]
    for finding in findings:
        print(finding)
    if findings:
        print(f"secret scan: {len(findings)} possible secret(s) found")
        return 1
    print("secret scan: clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
