"""The ``--print-config`` non-server mode.

Real-process tests: stdout carries only one valid JSON document, the
process exits without claiming stdio for the MCP protocol, and a missing
executable or an unknown client never dirties stdout.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from openreflex.clients import SUPPORTED_CLIENTS, generate_config, resolve_mcp_executable

_TIMEOUT_S = 30.0


def _run(*argv: str) -> subprocess.CompletedProcess[str]:
    # stdin is closed: a process that claimed stdio for MCP would block on read.
    return subprocess.run(
        [sys.executable, "-m", "openreflex_mcp", *argv],
        input="",
        capture_output=True,
        text=True,
        timeout=_TIMEOUT_S,
    )


@pytest.mark.parametrize("client", SUPPORTED_CLIENTS)
def test_print_config_prints_only_the_valid_json_config(client: str) -> None:
    out = _run("--print-config", client)
    assert out.returncode == 0, out.stderr
    data = json.loads(out.stdout)  # the entire stdout is one JSON document
    # No explanation or logs around it: at most one trailing newline.
    assert out.stdout == out.stdout.strip() + "\n"
    assert data == generate_config(client, resolve_mcp_executable())
    assert out.stderr == ""


def test_print_config_does_not_start_the_server_or_read_stdin() -> None:
    # stdin is closed; the MCP stdio server would block reading it. A clean,
    # quick JSON exit proves the protocol was never started.
    out = _run("--print-config", "opencode")
    assert out.returncode == 0
    assert json.loads(out.stdout)["$schema"] == "https://opencode.ai/config.json"


def test_print_config_unknown_client_keeps_stdout_clean() -> None:
    out = _run("--print-config", "claude-desktop")
    assert out.returncode != 0
    assert out.stdout == ""  # usage and the error go to stderr
    assert "claude-desktop" in out.stderr


def test_print_config_missing_executable_keeps_stdout_clean(tmp_path: Path) -> None:
    # Fake a frozen process whose sibling openreflex-mcp does not exist:
    # the resolution falls back to the (missing) console script next to the
    # executable, so the CLI reports it as not found.
    code = (
        "import sys\n"
        "from pathlib import Path\n"
        "from openreflex_mcp.cli import main\n"
        f"sys.executable = {str(tmp_path / 'nope.exe')!r}\n"
        "sys.frozen = True\n"
        "sys.exit(main(['--print-config', 'claude-code']))\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", code],
        input="",
        capture_output=True,
        text=True,
        timeout=_TIMEOUT_S,
    )
    assert out.returncode == 1
    assert out.stdout == ""
    assert "not found" in out.stderr
