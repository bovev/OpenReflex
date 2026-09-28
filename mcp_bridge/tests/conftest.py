"""In-process bridge fixtures: the MCP server talks to the real API app via TestClient."""

from __future__ import annotations

from collections.abc import AsyncGenerator, Callable, Iterator, Mapping
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from mcp import ClientSession
from mcp.shared.memory import create_connected_server_and_client_session
from pydantic import JsonValue

from openreflex import __version__
from openreflex.api.app import create_app, secured
from openreflex.context import AppContext, build_context
from openreflex.domain.engine import EngineResult
from openreflex.domain.recipe import Recipe
from openreflex.engine.fake import FakeEngine
from openreflex.lifecycle.instance import Discovered, Endpoint
from openreflex.settings import ServiceSettings
from openreflex_mcp.client import Response, ServiceClient
from openreflex_mcp.server import build_server

PORT = 47821


def discovered(token: str, port: int = PORT) -> Discovered:
    endpoint = Endpoint(pid=1, port=port, version=__version__, started_at="2026-09-21T00:00:00Z")
    return Discovered(endpoint=endpoint, token=token)


class SpyEngine(FakeEngine):
    """Records the state handed to the engine, to prove inputs stay inert text."""

    def __init__(self) -> None:
        super().__init__()
        self.states: list[dict[str, JsonValue]] = []

    def predict(self, state: dict[str, JsonValue], recipe: Recipe) -> EngineResult:
        self.states.append(dict(state))
        return super().predict(state, recipe)


@pytest.fixture
def engine() -> SpyEngine:
    return SpyEngine()


@pytest.fixture
def ctx(tmp_path: Path, engine: SpyEngine) -> Iterator[AppContext]:
    settings = ServiceSettings(data_dir=tmp_path / "data", port=PORT, engine="fake")
    context = build_context(settings, engine=engine)
    yield context
    context.close()


@pytest.fixture
def http(ctx: AppContext) -> Iterator[TestClient]:
    with TestClient(secured(ctx, create_app(ctx)), base_url=f"http://127.0.0.1:{PORT}") as c:  # type: ignore[arg-type]
        yield c


def testclient_send(
    http: TestClient,
) -> Callable[[str, str, Mapping[str, str], bytes | None, float], Response]:
    def send(
        method: str, url: str, headers: Mapping[str, str], body: bytes | None, timeout: float
    ) -> Response:
        reply = http.request(method, url, headers=dict(headers), content=body)
        return Response(reply.status_code, reply.content)

    return send


@pytest.fixture
def service_client(ctx: AppContext, http: TestClient, tmp_path: Path) -> ServiceClient:
    return ServiceClient(
        tmp_path / "data", connect=lambda _: discovered(ctx.token), send=testclient_send(http)
    )


@asynccontextmanager
async def session_for(client: ServiceClient) -> AsyncGenerator[ClientSession]:
    async with create_connected_server_and_client_session(build_server(client)) as session:
        yield session
