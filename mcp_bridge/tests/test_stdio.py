"""Real-process tests: the bridge over stdio, auto-starting a fake-engine service.

These never load weights or contact the network.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from openreflex.lifecycle.instance import discover, is_owned
from openreflex.paths import DATA_DIR_ENV
from openreflex.settings import ENGINE_ENV

_TIMEOUT_S = 30.0
SECRET_TEXT = "Invoice 9931 for ACME, card ending 4242"


def _environment(root: Path) -> dict[str, str]:
    return {**os.environ, DATA_DIR_ENV: str(root), ENGINE_ENV: "fake", "PYTHONUTF8": "1"}


class Bridge:
    """Drives ``python -m openreflex_mcp`` with raw newline-delimited JSON-RPC."""

    def __init__(self, root: Path) -> None:
        self.process = subprocess.Popen(
            [sys.executable, "-m", "openreflex_mcp"],
            env=_environment(root),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.stdout_lines: list[bytes] = []
        self._next_id = 0

    def send(self, message: dict[str, Any]) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(message).encode() + b"\n")
        self.process.stdin.flush()

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self._next_id += 1
        self.send({"jsonrpc": "2.0", "id": self._next_id, "method": method, "params": params or {}})
        assert self.process.stdout is not None
        while True:
            line = self.process.stdout.readline()
            if not line:
                raise AssertionError(f"bridge closed stdout; stderr:\n{self.finish()[1]}")
            self.stdout_lines.append(line)
            message = json.loads(line)
            if message.get("id") == self._next_id:
                return message

    def initialize(self) -> dict[str, Any]:
        reply = self.request(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "0"},
            },
        )
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return reply

    def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return self.request("tools/call", {"name": name, "arguments": arguments})["result"]

    def finish(self) -> tuple[bytes, str]:
        """Close stdin (the host going away) and collect the remaining output."""
        stdout, stderr = self.process.communicate(timeout=_TIMEOUT_S)
        self.stdout_lines.extend(stdout.splitlines(keepends=True))
        return stdout, stderr.decode("utf-8", "replace")


def _stop_service(root: Path) -> None:
    subprocess.run(
        [sys.executable, "-m", "openreflex.cli", "stop"],
        env=_environment(root),
        capture_output=True,
        timeout=_TIMEOUT_S,
        check=False,
    )
    deadline = time.monotonic() + _TIMEOUT_S
    while is_owned(root) and time.monotonic() < deadline:
        time.sleep(0.05)


def test_bridge_autostarts_one_service_and_keeps_stdout_protocol_clean(tmp_path: Path) -> None:
    root = tmp_path / "data"
    assert discover(root) is None
    first = Bridge(root)
    second: Bridge | None = None
    try:
        init = first.initialize()
        assert init["result"]["serverInfo"]["name"] == "openreflex-mcp"
        assert "needs_review" in init["result"]["instructions"]

        # Listing tools needs no service.
        tools = first.request("tools/list")["result"]["tools"]
        assert len(tools) == 6
        assert discover(root) is None

        result = first.call("run_decision", {"recipe_id": "email-triage", "input": SECRET_TEXT})
        assert result["isError"] is False, result
        assert result["structuredContent"]["status"] == "completed"
        service = discover(root)
        assert service is not None

        bad = first.call("run_decision", {"recipe_id": "email-triage", "url": "http://x"})
        assert bad["isError"] is True
        assert bad["structuredContent"]["error"]["code"] == "invalid_input"

        # A second MCP host reuses the same service: no second model owner.
        second = Bridge(root)
        second.initialize()
        listing = second.call("list_recipes", {})
        assert listing["isError"] is False
        assert discover(root) == service

        first_stdout, first_stderr = first.finish()
        second.finish()
        assert first.process.returncode == 0

        # Closing a host does not stop the service another host may be using.
        assert discover(root) == service

        # stdout carried only JSON-RPC messages; logs went to stderr without content.
        for line in [*first.stdout_lines, *second.stdout_lines]:
            assert json.loads(line)["jsonrpc"] == "2.0"
        assert first_stdout.strip() == b""
        assert SECRET_TEXT not in first_stderr
        assert '"tool": "run_decision"' in first_stderr
    finally:
        for bridge in (first, second):
            if bridge is not None and bridge.process.poll() is None:
                bridge.process.kill()
                bridge.process.communicate(timeout=_TIMEOUT_S)
        _stop_service(root)
    assert not is_owned(root)


def test_bridge_import_never_pulls_in_an_engine() -> None:
    probe = (
        "import sys, openreflex_mcp.cli\n"
        "bad = sorted(m for m in sys.modules if m.split('.')[0] in {'laya', 'torch'} "
        "or m.startswith(('openreflex.laya_adapter', 'openreflex.engine', 'openreflex.api')))\n"
        "print(bad)\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", probe],
        capture_output=True,
        text=True,
        timeout=_TIMEOUT_S,
        check=True,
    )
    assert out.stdout.strip() == "[]"


def test_version_flag() -> None:
    out = subprocess.run(
        [sys.executable, "-m", "openreflex_mcp", "--version"],
        capture_output=True,
        text=True,
        timeout=_TIMEOUT_S,
        check=True,
    )
    assert out.stdout.strip()
