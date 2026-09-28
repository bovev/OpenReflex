"""ASGI middleware enforcing the local trust boundary before any routing.

- ``Host`` must name the loopback address and our port (DNS-rebinding defence).
- A browser ``Origin``, when present, must be the UI's own origin. No CORS
  headers are ever sent, so other origins can't read responses.
- Everything except health checks and static UI files needs the bearer token.
- Request bodies are capped. Oversized requests fail before the app sees them.
- Every response carries a request id and restrictive security headers.
- Access logs record only method, route template, status, timing, and codes.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any, Final

from openreflex.domain.errors import ErrorBody, ErrorCode
from openreflex.security.tokens import token_matches

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

log = logging.getLogger("openreflex.access")

CSP: Final = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; "
    "base-uri 'none'; form-action 'self'"
)
SECURITY_HEADERS: Final = (
    (b"content-security-policy", CSP.encode()),
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"no-referrer"),
    (b"x-frame-options", b"DENY"),
    (b"cross-origin-resource-policy", b"same-origin"),
    (b"cross-origin-opener-policy", b"same-origin"),
)
PUBLIC_PREFIXES: Final = ("/health/", "/assets/")
PUBLIC_EXACT: Final = frozenset({"/", "/index.html", "/favicon.ico", "/favicon.svg"})


class _TooLarge(Exception):
    pass


class SecurityMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        *,
        token: Callable[[], str],
        port: Callable[[], int],
        max_body: int,
    ) -> None:
        self._app = app
        self._token = token
        self._port = port
        self._max_body = max_body

    def _allowed_hosts(self) -> set[str]:
        port = self._port()
        return {f"127.0.0.1:{port}", f"localhost:{port}"}

    def _allowed_origins(self) -> set[str]:
        return {f"http://{h}" for h in self._allowed_hosts()}

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
                return
            await self._app(scope, receive, send)
            return

        request_id = str(uuid.uuid4())
        scope.setdefault("state", {})["request_id"] = request_id
        started = time.perf_counter()
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        path: str = scope["path"]
        status_holder: dict[str, Any] = {"status": 500, "code": None}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
                extra = [(b"x-request-id", request_id.encode()), *SECURITY_HEADERS]
                if not path.startswith("/assets/"):
                    extra.append((b"cache-control", b"no-store"))
                message["headers"] = [*message.get("headers", []), *extra]
            await send(message)

        rejection = self._reject(headers, path)
        if rejection is not None:
            status, code, message_text = rejection
            status_holder["code"] = code
            await _send_error(send_wrapper, status, code, message_text, request_id)
            self._log(scope, status_holder, started, request_id)
            return

        received = 0
        overflow = False
        replied = False

        async def limited_receive() -> Message:
            nonlocal received, overflow
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self._max_body:
                    overflow = True
                    raise _TooLarge
            return message

        async def reply_413() -> None:
            nonlocal replied
            if not replied:
                replied = True
                status_holder["code"] = ErrorCode.INPUT_TOO_LARGE
                await _send_error(
                    send_wrapper,
                    413,
                    ErrorCode.INPUT_TOO_LARGE,
                    "request body is too large",
                    request_id,
                )

        async def guarded_send(message: Message) -> None:
            # Frameworks turn a failed body read into their own error response
            # (FastAPI: 400). Replace whatever they send with the real reason.
            if overflow:
                await reply_413()
                return
            await send_wrapper(message)

        try:
            await self._app(scope, limited_receive, guarded_send)
        except _TooLarge:
            await reply_413()
        finally:
            self._log(scope, status_holder, started, request_id)

    def _reject(self, headers: dict[str, str], path: str) -> tuple[int, ErrorCode, str] | None:
        if headers.get("host", "").lower() not in self._allowed_hosts():
            return 403, ErrorCode.FORBIDDEN, "unexpected Host header"
        origin = headers.get("origin")
        if origin is not None and origin.lower() not in self._allowed_origins():
            return 403, ErrorCode.FORBIDDEN, "cross-origin requests are not allowed"
        length = headers.get("content-length")
        if length is not None:
            try:
                too_big = int(length) > self._max_body
            except ValueError:
                return 400, ErrorCode.INVALID_INPUT, "invalid Content-Length"
            if too_big:
                return 413, ErrorCode.INPUT_TOO_LARGE, "request body is too large"
        if path in PUBLIC_EXACT or path.startswith(PUBLIC_PREFIXES):
            return None
        auth = headers.get("authorization", "")
        scheme, _, presented = auth.partition(" ")
        if scheme.lower() != "bearer" or not token_matches(self._token(), presented.strip()):
            return 401, ErrorCode.UNAUTHORIZED, "missing or invalid token"
        return None

    def _log(self, scope: Scope, status: dict[str, Any], started: float, request_id: str) -> None:
        route = scope.get("route")
        template = getattr(route, "path", None) or (
            "<static>" if status["status"] < 400 else "<unmatched>"
        )
        state = scope.get("state", {})
        code = status["code"] or state.get("error_code")
        log.info(
            "request",
            extra={
                "event": "request",
                "request_id": request_id,
                "method": scope.get("method"),
                "route": template,
                "status": status["status"],
                "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                "error_code": str(code) if code else None,
            },
        )


async def _send_error(
    send: Send, status: int, code: ErrorCode, message: str, request_id: str
) -> None:
    body = ErrorBody(code=code, message=message, request_id=request_id).model_dump_json().encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


def json_log_formatter() -> logging.Formatter:
    return _JsonFormatter()


_SAFE_FIELDS: Final = (
    "event",
    "request_id",
    "method",
    "route",
    "status",
    "duration_ms",
    "error_code",
    "profile",
    "revision",
    "state",
    "queue_depth",
    "tool",
    "exception",
)


class _JsonFormatter(logging.Formatter):
    """Emits only whitelisted fields, so stray content can't leak into logs."""

    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, Any] = {
            "ts": round(record.created, 3),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage() if record.name.startswith("openreflex") else "external",
        }
        for key in _SAFE_FIELDS:
            value = getattr(record, key, None)
            if value is not None:
                out[key] = value
        if record.exc_info and record.name.startswith("openreflex"):
            out["exception"] = record.exc_info[0].__name__ if record.exc_info[0] else None
        return json.dumps(out, ensure_ascii=False)
