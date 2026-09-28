"""Entry point of the ``openreflex-mcp`` executable (stdio MCP server)."""

from __future__ import annotations

import argparse
import contextlib
import logging
import sys
from collections.abc import Sequence
from io import TextIOWrapper
from typing import TextIO

import anyio
from mcp.server.stdio import stdio_server

from openreflex import __version__
from openreflex.clients import SUPPORTED_CLIENTS, generate_json, resolve_mcp_executable
from openreflex.identity import MCP_EXECUTABLE, PRODUCT_NAME
from openreflex.paths import data_dir
from openreflex.security.middleware import json_log_formatter
from openreflex_mcp.client import ServiceClient
from openreflex_mcp.server import build_server


def configure_logging() -> None:
    """Content-free JSON logs on stderr. The SDK logs raw messages at debug level."""
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(json_log_formatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.INFO)
    logging.getLogger("mcp").setLevel(logging.WARNING)


def claim_stdout() -> TextIO:
    """Reserve the real stdout for protocol messages; stray prints go to stderr."""
    protocol = sys.stdout
    sys.stdout = sys.stderr
    return protocol


async def _serve(protocol_out: TextIO) -> None:
    client = ServiceClient(data_dir())
    server = build_server(client)
    stdout = anyio.wrap_file(TextIOWrapper(protocol_out.buffer, encoding="utf-8"))
    async with stdio_server(stdout=stdout) as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


def _print_config(client: str) -> int:
    """Non-server mode: print one valid JSON document and exit.

    Stdout carries only the configuration, nothing else. The MCP stdio
    protocol is never started, so the process never reads stdin.
    """
    executable = resolve_mcp_executable()
    if not executable.is_file():
        print(
            f"installed {MCP_EXECUTABLE} executable not found at {executable}",
            file=sys.stderr,
        )
        return 1
    sys.stdout.write(generate_json(client, executable))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog=MCP_EXECUTABLE,
        description=f"stdio MCP server for the local {PRODUCT_NAME} service. "
        "Started by an MCP client, not by hand.",
    )
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument(
        "--print-config",
        metavar="CLIENT",
        choices=SUPPORTED_CLIENTS,
        help="print the MCP client configuration as JSON and exit; " "does not start the server",
    )
    args = parser.parse_args(argv)

    if args.print_config is not None:
        return _print_config(args.print_config)

    protocol_out = claim_stdout()
    configure_logging()
    with contextlib.suppress(KeyboardInterrupt):
        anyio.run(_serve, protocol_out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
