"""Test-only loopback service launcher for the browser end-to-end suite.

Starts a real OpenReflex service process - real HTTP on ``127.0.0.1``, the
real security middleware (host/origin validation, bearer token, body limit,
security headers) - with:

- a temporary data directory (supplied by the caller),
- the deterministic fake engine, and
- an in-memory artifact source, so a model "download" completes instantly
  without any network access.

The process prints exactly one JSON line on stdout::

    {"base_url": "http://127.0.0.1:<port>", "token": "<token>"}

and sends every log to stderr. The token is the service's real owner-only
token (``openreflex.security.tokens``); the suite reads it from stdout and
never from the filesystem. The process exits cleanly on the service's
authenticated ``POST /v1/shutdown``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections.abc import Iterator, Sequence
from pathlib import Path

import uvicorn

from openreflex.api.app import create_app, secured
from openreflex.context import AppContext, DownloadCoordinator, build_context
from openreflex.domain.recipe import ModelProfile
from openreflex.engine.fake import FakeEngine
from openreflex.lifecycle.instance import InstanceLock, bind_socket
from openreflex.models.catalog import Checkpoint, ModelFile
from openreflex.models.manager import ModelManager
from openreflex.settings import ServiceSettings

FAKE_REVISION: str = "f" * 40
CONFIG: bytes = b'{"max_len": 1024}'
WEIGHTS: bytes = b"w" * 5000


def _blob(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data, usedforsecurity=False).hexdigest()


class FakeArtifactSource:
    """Deterministic in-memory artifact source. Never touches the network."""

    def fetch(self, repo_id: str, revision: str, path: str, offset: int) -> Iterator[bytes]:
        data = {"rl_agent_config.json": CONFIG, "model.safetensors": WEIGHTS}[path]
        yield data[offset:]


def fake_catalog() -> dict[ModelProfile, Checkpoint]:
    """Small pinned checkpoints so every download is instant and verifiable."""
    files = (
        ModelFile(path="rl_agent_config.json", size=len(CONFIG), git_blob_sha1=_blob(CONFIG)),
        ModelFile(
            path="model.safetensors",
            size=len(WEIGHTS),
            sha256=hashlib.sha256(WEIGHTS).hexdigest(),
        ),
    )
    return {
        profile: Checkpoint(
            profile=profile,
            repo_id="fake/repo",
            revision=FAKE_REVISION,
            subfolder=None,
            files=files,
            max_len=512,
            head_max_len=192,
        )
        for profile in (
            ModelProfile.TYPED_DECISIONS,
            ModelProfile.ENGLISH,
            ModelProfile.MULTILINGUAL,
        )
    }


def build_fake_context(settings: ServiceSettings) -> AppContext:
    """A context wired with the fake engine and the in-memory source."""
    ctx = build_context(settings, engine=FakeEngine(), source=FakeArtifactSource())
    models = ModelManager(settings.models_dir, FakeArtifactSource(), fake_catalog())
    ctx.models = models
    ctx.downloads = DownloadCoordinator(models)
    return ctx


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a test-only fake OpenReflex service.")
    parser.add_argument("--data-dir", type=Path, required=True, help="temporary data directory")
    parser.add_argument(
        "--ui-dir", type=Path, default=None, help="built UI to serve (default: frontend/dist)"
    )
    args = parser.parse_args(argv)

    settings = ServiceSettings(data_dir=args.data_dir, engine="fake")
    ctx = build_fake_context(settings)
    lock = InstanceLock(settings.data_dir)
    if not lock.try_acquire():
        print("the data directory is already owned by another service", file=sys.stderr)
        return 1
    try:
        sock = bind_socket(settings.data_dir, 0)
        port = sock.getsockname()[1]
        ctx.port = port
        ui_dir = args.ui_dir
        if ui_dir is None:
            candidate = Path(__file__).resolve().parent.parent / "frontend" / "dist"
            ui_dir = candidate if (candidate / "index.html").is_file() else None
        app = create_app(ctx, ui_dir=ui_dir)
        server = uvicorn.Server(
            uvicorn.Config(
                secured(ctx, app),  # the real auth middleware
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
        # The single stdout line the suite reads; everything else goes to stderr.
        print(
            json.dumps({"base_url": f"http://127.0.0.1:{port}", "token": ctx.token}),
            flush=True,
        )
        server.run(sockets=[sock])
    finally:
        ctx.close()
        lock.release()
    return 0


if __name__ == "__main__":
    sys.exit(main())
