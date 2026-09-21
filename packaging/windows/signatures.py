"""Inventory every native PE file in a package and check its Authenticode signature.

    uv run python packaging/windows/signatures.py <package-dir> [--release] [--out FILE]

Every file that is a PE image counts, whatever its extension: .exe, .dll,
.pyd, .sys, and anything else starting with a valid MZ/PE header. In release
mode **every** PE file is required. The command exits non-zero when any of
them is unsigned or its signature can't be verified. There is deliberately no
exemption list. A payload that Windows Application Control could block must
not ship.

Signatures are checked with Windows' own ``Get-AuthenticodeSignature``, so
the check only runs on Windows. Release mode refuses to run anywhere else.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import subprocess
import sys
from collections.abc import Callable, Iterable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, cast

PE_EXTENSIONS = frozenset({".exe", ".dll", ".pyd", ".sys"})
VALID = "Valid"

_PS_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = foreach ($p in $paths) {
  try {
    $s = Get-AuthenticodeSignature -LiteralPath $p
    [pscustomobject]@{
      path = $p
      status = [string]$s.Status
      message = [string]$s.StatusMessage
      signer = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null }
      timestamped = [bool]$s.TimeStamperCertificate
      catalog = ([string]$s.SignatureType) -eq 'Catalog'
    }
  } catch {
    [pscustomobject]@{ path = $p; status = 'Error'; message = $_.Exception.Message;
                       signer = $null; timestamped = $false; catalog = $false }
  }
}
@($out) | ConvertTo-Json -Depth 3 -Compress
"""


@dataclass(frozen=True)
class Signature:
    status: str
    message: str
    signer: str | None
    timestamped: bool
    catalog: bool


@dataclass(frozen=True)
class Entry:
    path: str
    size: int
    sha256: str
    extension_listed: bool
    status: str
    message: str
    signer: str | None
    timestamped: bool
    catalog: bool

    @property
    def ok(self) -> bool:
        return self.status == VALID


Verifier = Callable[[Sequence[Path]], dict[Path, Signature]]


def is_pe(path: Path) -> bool:
    """True when ``path`` starts with a DOS header pointing at a PE signature."""
    try:
        with path.open("rb") as f:
            head = f.read(64)
            if len(head) < 64 or head[:2] != b"MZ":
                return False
            (offset,) = struct.unpack_from("<I", head, 0x3C)
            f.seek(offset)
            return f.read(4) == b"PE\0\0"
    except OSError:
        return False


def find_pe_files(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*") if p.is_file() and is_pe(p))


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def powershell_verifier(paths: Sequence[Path]) -> dict[Path, Signature]:
    """Verify signatures with Windows' Get-AuthenticodeSignature."""
    if sys.platform != "win32":
        raise RuntimeError("Authenticode verification is only available on Windows")
    if not paths:
        return {}
    # An inherited PSModulePath (e.g. from PowerShell 7) stops Windows PowerShell
    # from loading its own Security module, so start from the system default.
    env = {k: v for k, v in os.environ.items() if k.upper() != "PSMODULEPATH"}
    proc = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", _PS_SCRIPT],
        env=env,
        input=json.dumps([str(p) for p in paths]),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
        timeout=600,
    )
    raw: Any = json.loads(proc.stdout)
    rows = cast(list[dict[str, Any]], raw if isinstance(raw, list) else [raw])
    return {
        Path(r["path"]): Signature(
            status=str(r["status"]),
            message=str(r.get("message") or ""),
            signer=r.get("signer"),
            timestamped=bool(r.get("timestamped")),
            catalog=bool(r.get("catalog")),
        )
        for r in rows
    }


def inventory(root: Path, verifier: Verifier = powershell_verifier) -> list[Entry]:
    files = find_pe_files(root)
    sigs = verifier(files)
    entries: list[Entry] = []
    for path in files:
        sig = sigs.get(path) or Signature("Error", "no verification result", None, False, False)
        entries.append(
            Entry(
                path=path.relative_to(root).as_posix(),
                size=path.stat().st_size,
                sha256=_sha256(path),
                extension_listed=path.suffix.lower() in PE_EXTENSIONS,
                status=sig.status,
                message=sig.message,
                signer=sig.signer,
                timestamped=sig.timestamped,
                catalog=sig.catalog,
            )
        )
    return entries


def failures(entries: Iterable[Entry]) -> list[Entry]:
    """Entries that block a release. Every PE file is required to be signed."""
    return [e for e in entries if not e.ok]


def main(argv: Sequence[str] | None = None, verifier: Verifier = powershell_verifier) -> int:
    parser = argparse.ArgumentParser(description="Inventory and verify packaged PE files.")
    parser.add_argument("package_dir", type=Path)
    parser.add_argument("--release", action="store_true", help="fail on any unsigned PE file")
    parser.add_argument("--out", type=Path, help="write the JSON inventory here")
    args = parser.parse_args(argv)

    if args.release and sys.platform != "win32":
        print("signatures: release verification must run on Windows", file=sys.stderr)
        return 2
    root: Path = args.package_dir.resolve()
    if not root.is_dir():
        print(f"signatures: not a directory: {root}", file=sys.stderr)
        return 2

    entries = inventory(root, verifier)
    bad = failures(entries)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        report = {"package": root.name, "files": [asdict(e) for e in entries]}
        args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(f"signatures: {len(entries)} PE file(s), {len(entries) - len(bad)} valid, {len(bad)} not")
    for e in bad:
        print(f"  {e.status:<14} {e.path}  {e.message}".rstrip())
    if bad and args.release:
        print("signatures: release blocked: every shipped PE file must carry a valid signature")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
