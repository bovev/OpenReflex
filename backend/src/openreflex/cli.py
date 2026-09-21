"""Command-line entry point for the OpenReflex service executable."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import urllib.request
import webbrowser
from collections.abc import Sequence
from typing import Any

from openreflex import __version__
from openreflex.decisions import DecisionService
from openreflex.domain.errors import AppError
from openreflex.engine.fake import FakeEngine
from openreflex.identity import PRODUCT_NAME, SERVICE_EXECUTABLE
from openreflex.lifecycle.instance import discover
from openreflex.paths import data_dir, install_dir
from openreflex.recipes.store import RecipeStore
from openreflex.settings import default_settings


def smoke() -> dict[str, Any]:
    """Self-check used by packaging tests. Uses the fake engine, never a real model."""
    target = data_dir()
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target, prefix=".smoke-", delete=True) as probe:
        probe.write(b"ok")
        probe.flush()
    store = RecipeStore(target / "recipes")
    seeded = store.seed_examples()
    result = DecisionService(store, FakeEngine()).run(
        "email-triage", "We were charged twice for invoice 4471. Please refund."
    )
    return {
        "product": PRODUCT_NAME,
        "version": __version__,
        "frozen": bool(getattr(sys, "frozen", False)),
        "install_dir": str(install_dir()),
        "data_dir": str(target),
        "data_dir_writable": True,
        "examples_seeded": sorted(seeded),
        "decision": {
            "engine": "fake",
            "status": result.status.value,
            "questions": sorted(result.answers),
        },
    }


def _serve(args: argparse.Namespace) -> int:
    from openreflex.lifecycle.server import serve

    overrides: dict[str, object] = {"port": args.port}
    if args.engine:
        overrides["engine"] = args.engine
    running = serve(default_settings(**overrides))
    if running is not None:
        where = running.endpoint.base_url if running.endpoint else "an unknown port"
        print(f"{PRODUCT_NAME} is already running at {where}", file=sys.stderr)
    return 0


def _status() -> int:
    found = discover(data_dir())
    if found is None:
        print(json.dumps({"running": False}))
        return 1
    print(json.dumps({"running": True, **found.endpoint.model_dump()}, indent=2))
    return 0


def _stop() -> int:
    found = discover(data_dir())
    if found is None:
        print(f"{PRODUCT_NAME} is not running", file=sys.stderr)
        return 0
    request = urllib.request.Request(  # noqa: S310 - loopback http
        f"{found.endpoint.base_url}/v1/shutdown",
        method="POST",
        headers={"Authorization": f"Bearer {found.token}"},
    )
    with urllib.request.urlopen(request, timeout=10):  # noqa: S310
        pass
    return 0


def _open() -> int:
    from openreflex.lifecycle.launcher import ensure_running

    try:
        found = ensure_running(data_dir())
    except AppError as exc:
        print(exc.message, file=sys.stderr)
        return 1
    # The token travels in the URL fragment, which browsers never send to servers.
    webbrowser.open(f"{found.endpoint.base_url}/#token={found.token}")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog=SERVICE_EXECUTABLE)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("version", help="print the version")
    sub.add_parser("smoke", help="run a packaging self-check with the fake engine")
    serve = sub.add_parser("serve", help="run the local service (foreground)")
    serve.add_argument("--port", type=int, default=0, help="port on 127.0.0.1 (default: stable)")
    serve.add_argument("--engine", choices=["laya", "fake"], help="decision engine")
    sub.add_parser("status", help="show whether the service is running")
    sub.add_parser("stop", help="stop the running service")
    sub.add_parser("open", help="start the service if needed and open the local UI")
    args = parser.parse_args(argv)

    if args.command == "version":
        print(__version__)
        return 0
    if args.command == "smoke":
        print(json.dumps(smoke(), indent=2))
        return 0
    if args.command == "serve":
        return _serve(args)
    if args.command == "status":
        return _status()
    if args.command == "stop":
        return _stop()
    return _open()


if __name__ == "__main__":
    sys.exit(main())
