"""Start the service when needed and wait for it: used by the MCP bridge and ``open``."""

from __future__ import annotations

import os
import subprocess
import sys
import time
from collections.abc import Sequence
from pathlib import Path

from openreflex.domain.errors import AppError, ErrorCode
from openreflex.identity import SERVICE_EXECUTABLE
from openreflex.lifecycle.instance import Discovered, discover
from openreflex.paths import DATA_DIR_ENV

START_TIMEOUT_S = 30.0
_POLL_S = 0.2


def service_command() -> list[str]:
    """Argument vector that starts the installed service (never via a shell)."""
    if getattr(sys, "frozen", False):
        here = Path(sys.executable).resolve().parent
        for candidate in (
            here / f"{SERVICE_EXECUTABLE}.exe",
            here.parent / SERVICE_EXECUTABLE / f"{SERVICE_EXECUTABLE}.exe",
        ):
            if candidate.is_file():
                return [str(candidate), "serve"]
        raise AppError(
            ErrorCode.INTERNAL, "the service executable was not found next to this program"
        )
    return [sys.executable, "-m", "openreflex.cli", "serve"]


def start_detached(
    argv: Sequence[str], data_dir: Path, extra_env: dict[str, str] | None = None
) -> None:
    env = {**os.environ, DATA_DIR_ENV: str(data_dir), **(extra_env or {})}
    kwargs: dict[str, object] = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = (
            subprocess.DETACHED_PROCESS
            | subprocess.CREATE_NEW_PROCESS_GROUP
            | subprocess.CREATE_NO_WINDOW
        )
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(  # noqa: S603 - fixed argument vector, no shell
        list(argv),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        env=env,
        **kwargs,  # type: ignore[arg-type]
    )


def ensure_running(
    data_dir: Path,
    *,
    argv: Sequence[str] | None = None,
    timeout_s: float = START_TIMEOUT_S,
    extra_env: dict[str, str] | None = None,
) -> Discovered:
    """Return the running service, starting it if necessary."""
    found = discover(data_dir)
    if found is not None:
        return found
    start_detached(argv or service_command(), data_dir, extra_env)
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        found = discover(data_dir)
        if found is not None:
            return found
        time.sleep(_POLL_S)
    raise AppError(ErrorCode.SERVICE_UNAVAILABLE, "the local service did not start in time")
