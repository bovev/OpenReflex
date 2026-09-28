from __future__ import annotations

import hashlib
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from openreflex.api.app import create_app, secured
from openreflex.context import AppContext, build_context
from openreflex.domain.recipe import ModelProfile
from openreflex.engine.fake import FakeEngine
from openreflex.models.catalog import Checkpoint, ModelFile
from openreflex.models.manager import ModelManager
from openreflex.settings import ServiceSettings

PORT = 47821
BASE = f"http://127.0.0.1:{PORT}"
WEIGHTS = b"w" * 5000
CONFIG = b'{"max_len": 1024}'


def _blob(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data, usedforsecurity=False).hexdigest()


def small_catalog() -> dict[ModelProfile, Checkpoint]:
    files = (
        ModelFile(path="rl_agent_config.json", size=len(CONFIG), git_blob_sha1=_blob(CONFIG)),
        ModelFile(
            path="model.safetensors", size=len(WEIGHTS), sha256=hashlib.sha256(WEIGHTS).hexdigest()
        ),
    )
    return {
        p: Checkpoint(
            profile=p,
            repo_id="org/repo",
            revision="c" * 40,
            subfolder=None,
            files=files,
            max_len=512,
            head_max_len=192,
        )
        for p in (ModelProfile.TYPED_DECISIONS, ModelProfile.ENGLISH, ModelProfile.MULTILINGUAL)
    }


class MemorySource:
    def fetch(self, repo_id: str, revision: str, path: str, offset: int) -> Iterator[bytes]:
        yield {"rl_agent_config.json": CONFIG, "model.safetensors": WEIGHTS}[path][offset:]


def make_context(tmp_path: Path, engine: FakeEngine | None = None, **settings: Any) -> AppContext:
    cfg = ServiceSettings(data_dir=tmp_path / "data", port=PORT, engine="fake", **settings)
    ctx = build_context(cfg, engine=engine or FakeEngine(), source=MemorySource())
    ctx.models = ModelManager(cfg.models_dir, MemorySource(), small_catalog())
    ctx.downloads.__init__(ctx.models)  # type: ignore[misc]
    return ctx


@pytest.fixture
def ctx(tmp_path: Path) -> AppContext:
    return make_context(tmp_path)


def client_for(
    ctx: AppContext,
    *,
    auth: bool = True,
    mcp_executable_resolver: Callable[[], Path] | None = None,
) -> TestClient:
    app = secured(ctx, create_app(ctx, mcp_executable_resolver=mcp_executable_resolver))
    headers = {"Authorization": f"Bearer {ctx.token}"} if auth else {}
    return TestClient(app, base_url=BASE, headers=headers)  # type: ignore[arg-type]


@pytest.fixture
def client(ctx: AppContext) -> Iterator[TestClient]:
    with client_for(ctx) as c:
        yield c
    ctx.close()


@pytest.fixture
def anon(ctx: AppContext) -> Iterator[TestClient]:
    with client_for(ctx, auth=False) as c:
        yield c
