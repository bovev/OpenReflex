"""Filesystem locations for mutable state.

Mutable state always lives under the per-user application data directory,
never next to the installed program files.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from openreflex.identity import APP_DATA_DIR_NAME

DATA_DIR_ENV = "OPENREFLEX_DATA_DIR"


def data_dir() -> Path:
    """Return the per-user data directory (not created)."""
    override = os.environ.get(DATA_DIR_ENV)
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / APP_DATA_DIR_NAME
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / APP_DATA_DIR_NAME


def install_dir() -> Path:
    """Return the directory holding the program files (frozen or source)."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent
