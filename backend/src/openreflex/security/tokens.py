"""Per-install bearer token shared by the local UI and the MCP bridge."""

from __future__ import annotations

import hmac
import os
import secrets
import subprocess
import sys
from pathlib import Path
from typing import Final

TOKEN_FILE: Final = "auth-token"  # noqa: S105 - a file name, not a secret
_MIN_LENGTH: Final = 32


def restrict_to_current_user(path: Path) -> None:
    """Best effort: owner-only permissions on ``path``.

    On Windows, ``%LOCALAPPDATA%`` is already private to the user by default.
    This additionally removes inherited ACEs and grants only the current user.
    """
    if sys.platform != "win32":
        os.chmod(path, 0o600)
        return
    user = os.environ.get("USERNAME")
    if not user:
        return
    icacls = Path(os.environ.get("SYSTEMROOT", r"C:\Windows")) / "System32" / "icacls.exe"
    subprocess.run(  # noqa: S603 - fixed system binary, argument list, no shell
        [str(icacls), str(path), "/inheritance:r", "/grant:r", f"{user}:F"],
        check=False,
        capture_output=True,
        timeout=30,
    )


def load_or_create_token(root: Path) -> str:
    path = root / TOKEN_FILE
    try:
        token = path.read_text(encoding="utf-8").strip()
        if len(token) >= _MIN_LENGTH:
            return token
    except FileNotFoundError:
        pass
    root.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(token)
    restrict_to_current_user(tmp)
    os.replace(tmp, path)
    return token


def read_token(root: Path) -> str | None:
    try:
        token = (root / TOKEN_FILE).read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    return token if len(token) >= _MIN_LENGTH else None


def token_matches(expected: str, presented: str | None) -> bool:
    return presented is not None and hmac.compare_digest(expected.encode(), presented.encode())
