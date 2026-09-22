"""GET /v1/connections: generated config plus steps, without leaking anything."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi.testclient import TestClient

from openreflex.clients import SUPPORTED_CLIENTS
from openreflex.context import AppContext


def _packaged_path() -> Path:
    if os.name == "nt":
        return Path("C:/Program Files/OpenReflex/openreflex-mcp.exe")
    return Path("/opt/OpenReflex/openreflex-mcp")


def test_connections_requires_token(anon: TestClient) -> None:
    response = anon.get("/v1/connections")
    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


def test_connections_shape(client: TestClient) -> None:
    body = client.get("/v1/connections").json()
    # The two standing notes: external clients are not offline, and
    # OpenReflex never touches a client's configuration.
    assert "remotely" in body["privacy_note"]
    assert "never" in body["configuration_policy"]
    assert [c["client"] for c in body["clients"]] == list(SUPPORTED_CLIENTS)
    for entry in body["clients"]:
        assert entry["setup"] and entry["restart"] and entry["removal"]
        assert entry["schema_source"].startswith("https://")
        assert entry["schema_verified"]
        assert entry["config"]


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, (dict, list)):
        children = cast("list[Any]", value.values() if isinstance(value, dict) else value)
        return [s for v in children for s in _strings(v)]
    return []


def _command_of(client: str, config: dict[str, Any]) -> Any:
    if client == "claude-code":
        return config["mcpServers"]["openreflex"]["command"]
    if client == "opencode":
        return config["mcp"]["openreflex"]["command"]
    return config["servers"]["openreflex"]["command"]


def test_connections_uses_the_injected_packaged_path(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    packaged = _packaged_path()
    monkeypatch.setattr("openreflex.api.app.resolve_mcp_executable", lambda: packaged)
    data = client.get("/v1/connections").json()
    for entry in data["clients"]:
        expected = str(packaged) if entry["client"] != "opencode" else [str(packaged)]
        assert _command_of(entry["client"], entry["config"]) == expected
    # No development-only paths when a packaged path is supplied.
    for s in _strings(data):
        assert ".venv" not in s
        assert str(Path.cwd()) not in s
        assert sys.executable not in s


def test_connections_never_exposes_token_or_client_config_paths(
    client: TestClient, ctx: AppContext
) -> None:
    data = client.get("/v1/connections").json()
    for s in _strings(data):
        assert ctx.token not in s
        assert str(ctx.settings.data_dir) not in s
    # Client configuration files are never referenced as absolute paths.
    absolute = re.compile(r"^(?:[A-Za-z]:[\\/]|/)")
    for s in _strings(data):
        for name in ("claude.json", "opencode.json", "mcp.json"):
            for token in s.split():
                if name in token:
                    assert not absolute.match(token), token


def test_connections_never_touches_client_configuration_files(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    sentinel = home / "claude.json"
    sentinel.write_text('{"existing": true}\n', encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    before = sorted(p.name for p in home.iterdir())
    client.get("/v1/connections")
    after = sorted(p.name for p in home.iterdir())
    assert before == after
    assert sentinel.read_text(encoding="utf-8") == '{"existing": true}\n'
