"""Run the service: own the instance, bind loopback, serve, clean up."""

from __future__ import annotations

import logging
import logging.handlers
import sys
from dataclasses import dataclass
from pathlib import Path

import uvicorn

from openreflex.api.app import create_app, secured
from openreflex.context import build_context
from openreflex.lifecycle.instance import (
    Endpoint,
    InstanceLock,
    bind_socket,
    discover,
    read_endpoint,
)
from openreflex.paths import install_dir
from openreflex.security.middleware import json_log_formatter
from openreflex.settings import ServiceSettings

log = logging.getLogger("openreflex.lifecycle")


def configure_logging(logs_dir: Path) -> None:
    """JSON logs to stderr and a rotating file. Never stdout."""
    logs_dir.mkdir(parents=True, exist_ok=True)
    formatter = json_log_formatter()
    handlers: list[logging.Handler] = [
        logging.StreamHandler(sys.stderr),
        logging.handlers.RotatingFileHandler(
            logs_dir / "service.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8"
        ),
    ]
    for handler in handlers:
        handler.setFormatter(formatter)
    root = logging.getLogger()
    root.handlers[:] = handlers
    root.setLevel(logging.INFO)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.handlers[:] = []
        logger.propagate = name != "uvicorn.access"


@dataclass(frozen=True)
class AlreadyRunning:
    endpoint: Endpoint | None


def ui_dir() -> Path | None:
    for candidate in (install_dir() / "ui", install_dir().parents[2] / "frontend" / "dist"):
        if (candidate / "index.html").is_file():
            return candidate
    return None


def serve(settings: ServiceSettings) -> AlreadyRunning | None:
    """Blocking. Returns AlreadyRunning without starting when another instance owns the data."""
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    lock = InstanceLock(settings.data_dir)
    if not lock.try_acquire():
        found = discover(settings.data_dir, check_health=False)
        return AlreadyRunning(found.endpoint if found else read_endpoint(settings.data_dir))
    configure_logging(settings.logs_dir)
    ctx = None
    try:
        sock = bind_socket(settings.data_dir, settings.port)
        port = sock.getsockname()[1]
        ctx = build_context(settings)
        ctx.port = port
        app = create_app(ctx, ui_dir=ui_dir())
        server = uvicorn.Server(
            uvicorn.Config(
                secured(ctx, app),
                log_config=None,
                access_log=False,
                server_header=False,
                date_header=False,
                proxy_headers=False,
                lifespan="off",
                timeout_graceful_shutdown=5,
            )
        )
        app.state.request_shutdown = lambda: setattr(server, "should_exit", True)
        lock.publish(port)
        log.info("service started", extra={"event": "started", "state": "running"})
        server.run(sockets=[sock])
    finally:
        if ctx is not None:
            ctx.close()
        lock.release()
        log.info("service stopped", extra={"event": "stopped", "state": "stopped"})
    return None
