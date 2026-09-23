"""Product-owned MCP client configuration generation.

One generator serves every consumer — the ``openreflex-mcp --print-config``
CLI, ``GET /v1/connections``, the tests, and the later Connections screen —
so they all emit identical output for the same executable path.

Two standing rules:

- The generator never reads, creates, or modifies a client's configuration
  file. It only produces JSON and step-by-step instructions for the user
  to apply manually, and the instructions preserve every unrelated entry.
- External AI clients (Claude, Copilot, OpenCode) are not offline: content
  you send them may be processed remotely under their own terms.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from openreflex.identity import MCP_EXECUTABLE

#: The only client identifiers this product supports in V1.
SUPPORTED_CLIENTS: Final = ("claude-code", "opencode", "vscode-copilot")

#: The server name every client uses for this executable.
SERVER_NAME: Final = "openreflex"

#: Date on which each documented shape was checked against the client's
#: authoritative documentation (see ``docs/mcp-clients.md``).
SCHEMA_VERIFIED: Final = "2026-09-21"

#: The privacy distinction every consumer must repeat.
PRIVACY_NOTE: Final = (
    "Connecting an external AI client does not make the workflow offline: "
    "Claude, Copilot, and OpenCode may process the content you send them "
    "remotely under their own terms. The model and your recipes stay on "
    "this computer; the client is only a front door."
)

#: What OpenReflex never does to a client's configuration.
CONFIGURATION_POLICY: Final = (
    "OpenReflex never reads, merges, or overwrites your client configuration. "
    "Apply the generated JSON manually and keep every existing entry."
)


class UnknownClient(ValueError):
    """A client identifier outside SUPPORTED_CLIENTS."""


@dataclass(frozen=True)
class ClientSetup:
    """One client's complete setup: the config to merge, the steps, the provenance.

    ``verification`` is a dedicated, per-client step: every supported
    client gets server-owned guidance for checking that the connection
    works, separate from the merge (``setup``) and ``restart`` steps.
    """

    client: str
    name: str
    config: dict[str, Any]
    setup: tuple[str, ...]
    verification: tuple[str, ...]
    restart: tuple[str, ...]
    removal: tuple[str, ...]
    schema_source: str
    schema_verified: str = SCHEMA_VERIFIED


def _claude_code(executable: Path) -> ClientSetup:
    return ClientSetup(
        client="claude-code",
        name="Claude Code",
        config={
            "mcpServers": {
                SERVER_NAME: {
                    # The executable is invoked directly; never through a shell.
                    "command": str(executable),
                    "args": [],
                    "env": {},
                }
            }
        },
        setup=(
            "Merge the JSON below into your Claude Code MCP configuration "
            "(user scope: ~/.claude.json, or project scope: .mcp.json). "
            "Keep every existing entry; add only the 'openreflex' server.",
        ),
        verification=(
            "Check the connection with 'claude mcp get openreflex' (or /mcp " "inside a session).",
        ),
        restart=("Restart Claude Code so it starts the MCP server.",),
        removal=(
            "Remove the 'openreflex' entry you added ('claude mcp remove "
            "openreflex'), keep every other entry, and restart Claude Code.",
        ),
        schema_source="https://docs.anthropic.com/en/docs/claude-code/mcp",
    )


def _opencode(executable: Path) -> ClientSetup:
    return ClientSetup(
        client="opencode",
        name="OpenCode",
        config={
            "$schema": "https://opencode.ai/config.json",
            "mcp": {
                SERVER_NAME: {
                    "type": "local",
                    # OpenCode's local servers use a command array.
                    "command": [str(executable)],
                    "enabled": True,
                }
            },
        },
        setup=(
            "Merge the JSON below into your OpenCode configuration (user scope: "
            "~/.config/opencode/opencode.json, or the project's opencode.json). "
            "Keep every existing entry; add only the 'openreflex' server.",
        ),
        verification=(
            "Check the connection in your OpenCode session with the /mcp "
            "command, which lists the configured MCP servers and their status.",
        ),
        restart=("Restart your OpenCode session so it starts the MCP server.",),
        removal=(
            "Remove the 'openreflex' entry you added from the same configuration "
            "file, keep every other entry, and restart the session.",
        ),
        schema_source="https://opencode.ai/docs/mcp-servers",
    )


def _vscode_copilot(executable: Path) -> ClientSetup:
    return ClientSetup(
        client="vscode-copilot",
        name="VS Code / GitHub Copilot",
        config={
            "servers": {
                SERVER_NAME: {
                    "type": "stdio",
                    # The executable is invoked directly; never through a shell.
                    "command": str(executable),
                    "args": [],
                    "env": {},
                }
            }
        },
        setup=(
            "Merge the JSON below into your VS Code MCP configuration (workspace "
            ".vscode/mcp.json or the user profile mcp.json) or your Copilot "
            "configuration (workspace .mcp.json or ~/.copilot/mcp-config.json). "
            "Keep every existing entry; add only the 'openreflex' server.",
        ),
        verification=(
            "Check the connection in the VS Code Chat view, where the "
            "openreflex server's status is shown (or in the Copilot chat "
            "panel for portable Copilot configuration).",
        ),
        restart=(
            "Reload the VS Code window (or restart the Copilot session) so it "
            "starts the MCP server.",
        ),
        removal=(
            "Remove the 'openreflex' entry you added from the same configuration, "
            "keep every other entry, and reload the window.",
        ),
        schema_source=(
            "https://code.visualstudio.com/docs/copilot/customization/mcp-servers; "
            "https://docs.github.com/en/copilot/how-tos/provide-context/"
            "use-mcp-in-your-ide/extend-copilot-chat-with-mcp"
        ),
    )


_BUILDERS: Final[dict[str, Callable[[Path], ClientSetup]]] = {
    "claude-code": _claude_code,
    "opencode": _opencode,
    "vscode-copilot": _vscode_copilot,
}


def generate(client: str, executable: Path) -> ClientSetup:
    """The complete setup for one client. Raises UnknownClient otherwise."""
    builder = _BUILDERS.get(client)
    if builder is None:
        raise UnknownClient(
            f"unknown client '{client}'; expected one of {', '.join(SUPPORTED_CLIENTS)}"
        )
    return builder(executable)


def generate_config(client: str, executable: Path) -> dict[str, Any]:
    """The exact JSON snippet to merge into one client's configuration."""
    return generate(client, executable).config


def generate_json(client: str, executable: Path) -> str:
    """Deterministic JSON text: the same input always yields the same bytes.

    The executable path is JSON-escaped (spaces, quotes, backslashes,
    non-ASCII), so the text is safe to paste or store as-is.
    """
    return json.dumps(generate_config(client, executable), indent=2, ensure_ascii=False) + "\n"


def all_clients(executable: Path) -> list[ClientSetup]:
    """Setups for every supported client, in SUPPORTED_CLIENTS order."""
    return [generate(client, executable) for client in SUPPORTED_CLIENTS]


def _mcp_name() -> str:
    return f"{MCP_EXECUTABLE}.exe" if os.name == "nt" else MCP_EXECUTABLE


def _frozen_mcp_executable() -> Path:
    """The installed ``openreflex-mcp`` for this frozen process.

    A frozen ``openreflex-mcp`` is itself. Any other frozen process — in
    particular ``openreflex-service`` — lives next to the MCP executable in
    the packaged two-executable layout, so the sibling is the answer.
    """
    exe = Path(sys.executable)
    name = exe.name
    if os.name == "nt" and name.lower().endswith(".exe"):
        name = name[: -len(".exe")]
    if name.lower() == MCP_EXECUTABLE:
        return exe.resolve()
    return exe.resolve().parent / _mcp_name()


def resolve_mcp_executable(resolver: Callable[[], Path] | None = None) -> Path:
    """Absolute path of the installed ``openreflex-mcp`` executable.

    ``resolver`` is the injectable installed-path source: the packaged
    layout (or a test) supplies the real path through it, and it wins over
    every built-in rule. With no resolver: a frozen ``openreflex-mcp`` is
    itself; a frozen ``openreflex-service`` finds it next to itself; in
    development the console script installed next to the current
    interpreter is used.
    """
    if resolver is not None:
        return Path(resolver()).resolve()
    if getattr(sys, "frozen", False):
        return _frozen_mcp_executable()
    return Path(sys.executable).resolve().parent / _mcp_name()
