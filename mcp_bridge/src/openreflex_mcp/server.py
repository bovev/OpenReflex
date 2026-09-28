"""The MCP server: lists the tools and forwards calls to the local service.

Every failure becomes a compact structured tool error (``isError``) with a
stable code, never a Python traceback. Logs carry the tool name, outcome
code, and duration only.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Final

import anyio.to_thread
from mcp import types
from mcp.server.lowlevel import Server

from openreflex import __version__
from openreflex.domain.errors import ErrorBody, ErrorCode
from openreflex.identity import ATTRIBUTION, MCP_EXECUTABLE, PRODUCT_NAME
from openreflex_mcp.client import BridgeError, ServiceClient
from openreflex_mcp.tools import BY_NAME, TOOLS, parse_args

log = logging.getLogger("openreflex.mcp")

INSTRUCTIONS: Final = (
    f"{PRODUCT_NAME} runs typed decision recipes (choice, score, yes/no) with a Laya model "
    "on this computer. Decisions and recipe storage are local, but content you pass to "
    "these tools may already have been processed by the AI client itself. Results include "
    "a review state: treat 'needs_review' as requiring a person, and never treat a "
    "probability as proof of correctness. Ask the user before save_recipe or "
    f"delete_recipe. {ATTRIBUTION}"
)


def _json(data: object) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)


def error_result(error: ErrorBody) -> types.CallToolResult:
    payload = {"error": error.model_dump(mode="json", exclude_none=True)}
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=_json(payload))],
        structuredContent=payload,
        isError=True,
    )


def ok_result(data: dict[str, Any]) -> types.CallToolResult:
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=_json(data))],
        structuredContent=data,
        isError=False,
    )


def call(client: ServiceClient, name: str, arguments: dict[str, Any]) -> types.CallToolResult:
    """Run one tool synchronously. Never raises."""
    spec = BY_NAME.get(name)
    if spec is None:
        return error_result(ErrorBody(code=ErrorCode.NOT_FOUND, message=f"unknown tool '{name}'"))
    started = time.perf_counter()
    code: ErrorCode | None = None
    try:
        return ok_result(spec.handler(client, parse_args(spec, arguments)))
    except BridgeError as exc:
        code = exc.error.code
        return error_result(exc.error)
    except Exception as exc:
        code = ErrorCode.INTERNAL
        # Type only: messages and tracebacks can carry payload content.
        log.error(
            "tool failed",
            extra={"event": "tool_failed", "tool": name, "exception": type(exc).__name__},
        )
        return error_result(ErrorBody(code=code, message="internal error in the MCP bridge"))
    finally:
        log.info(
            "tool call",
            extra={
                "event": "tool_call",
                "tool": name,
                "error_code": str(code) if code else None,
                "duration_ms": round((time.perf_counter() - started) * 1000, 1),
            },
        )


def build_server(client: ServiceClient) -> Server[Any, Any]:
    server: Server[Any, Any] = Server(
        MCP_EXECUTABLE, version=__version__, instructions=INSTRUCTIONS
    )
    definitions = [tool.definition() for tool in TOOLS]

    @server.list_tools()
    async def _list() -> list[types.Tool]:  # pyright: ignore[reportUnusedFunction]
        return definitions

    # Arguments are validated by the strict models so errors stay structured.
    @server.call_tool(validate_input=False)
    async def _call(  # pyright: ignore[reportUnusedFunction]
        name: str, arguments: dict[str, Any]
    ) -> types.CallToolResult:
        return await anyio.to_thread.run_sync(call, client, name, arguments)

    return server
