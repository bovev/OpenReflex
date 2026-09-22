"""The product-owned client configuration generator.

Domain-level: no FastAPI, no Laya. Covers every output shape, path
escaping, deterministic output, and the promise that the generator never
touches a client's configuration file.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, cast

import pytest

from openreflex.clients import (
    SUPPORTED_CLIENTS,
    UnknownClient,
    all_clients,
    generate,
    generate_config,
    generate_json,
    resolve_mcp_executable,
)

SIMPLE = Path("/opt/OpenReflex/openreflex-mcp")
TRICKY = Path('/Program Files/OpenReflex "beta"/配置/openreflex-mcp.exe')


def _packaged_path() -> Path:
    if os.name == "nt":
        return Path("C:/Program Files/OpenReflex/openreflex-mcp.exe")
    return Path("/opt/OpenReflex/openreflex-mcp")


def _command_of(client: str, data: dict[str, Any]) -> Any:
    if client == "claude-code":
        return data["mcpServers"]["openreflex"]["command"]
    if client == "opencode":
        return data["mcp"]["openreflex"]["command"]
    return data["servers"]["openreflex"]["command"]


def test_supported_clients_are_the_v1_set() -> None:
    assert SUPPORTED_CLIENTS == ("claude-code", "opencode", "vscode-copilot")


@pytest.mark.parametrize("client", ["claude-desktop", "Claude Code", "vscode", ""])
def test_unknown_client_is_rejected(client: str) -> None:
    with pytest.raises(UnknownClient):
        generate_config(client, SIMPLE)
    with pytest.raises(UnknownClient):
        generate(client, SIMPLE)


@pytest.mark.parametrize("client", SUPPORTED_CLIENTS)
def test_shape_is_the_documented_stdio_shape(client: str) -> None:
    cfg = generate_config(client, SIMPLE)
    if client == "claude-code":
        assert cfg == {
            "mcpServers": {"openreflex": {"command": str(SIMPLE), "args": [], "env": {}}}
        }
    elif client == "opencode":
        # The schema declaration and a local command array, not a string.
        assert cfg["$schema"] == "https://opencode.ai/config.json"
        assert cfg["mcp"]["openreflex"] == {
            "type": "local",
            "command": [str(SIMPLE)],
            "enabled": True,
        }
    else:
        assert cfg == {
            "servers": {
                "openreflex": {
                    "type": "stdio",
                    "command": str(SIMPLE),
                    "args": [],
                    "env": {},
                }
            }
        }
    # Every client invokes the executable directly; never through a shell.
    command = _command_of(client, cfg)
    assert command in (str(SIMPLE), [str(SIMPLE)])


@pytest.mark.parametrize(
    "path",
    [
        SIMPLE,
        Path("/Program Files/OpenReflex/openreflex-mcp.exe"),  # spaces
        Path('/Program Files/OpenReflex "beta"/openreflex-mcp.exe'),  # quotes
        Path("/opt/配置/OpenReflex/openreflex-mcp.exe"),  # non-ASCII
        Path("C:\\Program Files\\OpenReflex\\openreflex-mcp.exe"),  # backslashes
        Path('/a/b/c d/e "f"\\g/öpenréflex-mcp.exe'),  # all of the above
    ],
)
def test_path_escaping_round_trips(path: Path) -> None:
    for client in SUPPORTED_CLIENTS:
        text = generate_json(client, path)
        data = json.loads(text)  # valid JSON even for tricky paths
        expected = str(path) if client != "opencode" else [str(path)]
        assert _command_of(client, data) == expected


def test_json_text_escapes_backslashes_and_quotes() -> None:
    text = generate_json("claude-code", Path('C:\\Program Files\\"beta"/openreflex-mcp.exe'))
    assert '\\"' in text  # the quote is escaped
    assert "\\\\" in text  # backslashes are escaped


def test_output_is_deterministic() -> None:
    for client in SUPPORTED_CLIENTS:
        assert generate_json(client, TRICKY) == generate_json(client, TRICKY)
        assert generate(client, TRICKY) == generate(client, TRICKY)
        first = json.loads(generate_json(client, TRICKY))
        second = json.loads(generate_json(client, TRICKY))
        assert list(first) == list(second)  # stable key order
    assert generate_json("opencode", TRICKY) != generate_json("claude-code", TRICKY)
    assert all_clients(TRICKY) == [generate(c, TRICKY) for c in SUPPORTED_CLIENTS]


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, (dict, list)):
        children = cast("list[Any]", value.values() if isinstance(value, dict) else value)
        return [s for v in children for s in _strings(v)]
    return []


def test_packaged_path_is_the_only_path_in_the_output() -> None:
    packaged = _packaged_path()
    for client in SUPPORTED_CLIENTS:
        data = json.loads(generate_json(client, packaged))
        expected = str(packaged) if client != "opencode" else [str(packaged)]
        assert _command_of(client, data) == expected
        for marker in (str(Path.cwd()), ".venv", "AppData", str(Path.home())):
            for s in _strings(data):
                assert marker not in s


def test_generator_never_touches_client_configuration_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    sentinel = home / "claude.json"
    sentinel.write_text('{"existing": true}', encoding="utf-8")
    (home / "opencode.json").write_text('{"other": 1}', encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    before = sorted(p.name for p in home.iterdir())
    for client in SUPPORTED_CLIENTS:
        generate_json(client, _packaged_path())
    after = sorted(p.name for p in home.iterdir())
    assert before == after
    assert sentinel.read_text(encoding="utf-8") == '{"existing": true}'


def test_resolve_mcp_executable_frozen_is_the_executable_itself(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    packaged = _packaged_path()
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(packaged))
    assert resolve_mcp_executable() == packaged


def test_resolve_mcp_executable_development_uses_the_console_script(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delattr(sys, "frozen", raising=False)
    monkeypatch.setattr(sys, "executable", "/some/venv/bin/python")
    name = "openreflex-mcp.exe" if os.name == "nt" else "openreflex-mcp"
    assert resolve_mcp_executable() == Path("/some/venv/bin").resolve() / name
