"""Single-instance ownership and endpoint discovery.

One service process owns the model and local state. Ownership is an OS file
lock on ``<data>/service.lock`` held for the process lifetime. The OS releases
it on exit or crash, so a stale ``service.json`` from a crashed process is
simply ignored and overwritten.

``service.json`` tells clients (browser launcher, MCP bridge) where the
running service listens. The bearer token lives separately in the
owner-only token file.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import json
import os
import socket
import urllib.error
import urllib.request
from pathlib import Path
from typing import Final

from pydantic import BaseModel, ConfigDict, ValidationError

from openreflex import __version__
from openreflex.models.locking import FileLock, LockHeld
from openreflex.security.tokens import read_token
from openreflex.settings import DEFAULT_PORT, LOOPBACK

LOCK_FILE: Final = "service.lock"
STATE_FILE: Final = "service.json"
PORT_FILE: Final = "port"


class Endpoint(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    pid: int
    port: int
    version: str
    started_at: str

    @property
    def base_url(self) -> str:
        return f"http://{LOOPBACK}:{self.port}"


class Discovered(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    endpoint: Endpoint
    token: str


class InstanceLock:
    """Held by the running service for its whole lifetime."""

    def __init__(self, data_dir: Path) -> None:
        self._data_dir = data_dir
        self._lock = FileLock(data_dir / LOCK_FILE)

    def try_acquire(self) -> bool:
        try:
            self._lock.acquire()
        except LockHeld:
            return False
        return True

    def publish(self, port: int) -> Endpoint:
        endpoint = Endpoint(
            pid=os.getpid(),
            port=port,
            version=__version__,
            started_at=dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        )
        _write_atomic(self._data_dir / STATE_FILE, endpoint.model_dump_json(indent=2))
        _write_atomic(self._data_dir / PORT_FILE, str(port))
        return endpoint

    def release(self) -> None:
        if self._lock.held:
            (self._data_dir / STATE_FILE).unlink(missing_ok=True)
            self._lock.release()


def is_owned(data_dir: Path) -> bool:
    """True when some process currently holds the instance lock."""
    probe = FileLock(data_dir / LOCK_FILE)
    try:
        probe.acquire()
    except LockHeld:
        return True
    probe.release()
    return False


def read_endpoint(data_dir: Path) -> Endpoint | None:
    try:
        return Endpoint.model_validate_json((data_dir / STATE_FILE).read_bytes())
    except (FileNotFoundError, ValidationError, ValueError):
        return None


def healthy(endpoint: Endpoint, timeout_s: float = 1.0) -> bool:
    url = f"{endpoint.base_url}/health/live"  # always http://127.0.0.1:<port>
    try:
        with urllib.request.urlopen(url, timeout=timeout_s) as response:  # noqa: S310
            return response.status == 200 and json.loads(response.read()).get("status") == "ok"
    except (OSError, ValueError, urllib.error.URLError):
        return False


def discover(data_dir: Path, *, check_health: bool = True) -> Discovered | None:
    """Find the running service, or None. Stale state from a crash is ignored."""
    if not is_owned(data_dir):
        return None
    endpoint = read_endpoint(data_dir)
    token = read_token(data_dir)
    if endpoint is None or token is None:
        return None
    if check_health and not healthy(endpoint):
        return None
    return Discovered(endpoint=endpoint, token=token)


def bind_socket(data_dir: Path, requested: int = 0) -> socket.socket:
    """Bind a loopback listening socket on a stable port.

    Preference order: an explicitly requested port, the port used last time,
    the default port, then any free port. The chosen port is recorded by
    ``InstanceLock.publish``.
    """
    candidates: list[int] = []
    if requested:
        candidates.append(requested)
    else:
        with contextlib.suppress(FileNotFoundError, ValueError):
            candidates.append(int((data_dir / PORT_FILE).read_text(encoding="utf-8").strip()))
        candidates.extend([DEFAULT_PORT, 0])
    last_error: OSError | None = None
    for port in candidates:
        if not 0 <= port <= 65535:
            continue
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if os.name != "nt":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        else:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            sock.bind((LOOPBACK, port))
        except OSError as exc:
            sock.close()
            last_error = exc
            if requested:
                break
            continue
        sock.listen(64)
        return sock
    raise OSError(f"could not bind a local port: {last_error}")


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)
