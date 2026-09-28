"""Loopback HTTP client for the local service, used by the MCP bridge.

The service is discovered through app state (``service.json`` + token file)
and started on demand. A request that never reached the service (connection
refused) or was rejected before routing (401 after a token change) is retried
once against a freshly discovered instance. Nothing here logs request or
response content.
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from openreflex.domain.errors import AppError, ErrorBody, ErrorCode, Issue
from openreflex.lifecycle.instance import Discovered
from openreflex.lifecycle.launcher import ensure_running

# Covers the service's inference timeout (120 s) plus queueing.
REQUEST_TIMEOUT_S: Final = 150.0


@dataclass(frozen=True)
class Response:
    status: int
    body: bytes


Send = Callable[[str, str, Mapping[str, str], bytes | None, float], Response]
"""(method, url, headers, body, timeout) -> Response. Raises OSError if unreachable."""


class BridgeError(Exception):
    """A failure to report to the MCP caller as a structured tool error."""

    def __init__(self, error: ErrorBody) -> None:
        super().__init__(error.message)
        self.error = error

    @classmethod
    def of(cls, code: ErrorCode, message: str, issues: list[Issue] | None = None) -> BridgeError:
        return cls(ErrorBody(code=code, message=message, issues=issues or []))


def urllib_send(
    method: str, url: str, headers: Mapping[str, str], body: bytes | None, timeout: float
) -> Response:
    request = urllib.request.Request(  # noqa: S310 - always http://127.0.0.1:<port>
        url, data=body, method=method, headers=dict(headers)
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as reply:  # noqa: S310
            return Response(reply.status, reply.read())
    except urllib.error.HTTPError as exc:
        with exc:
            return Response(exc.code, exc.read())
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, TimeoutError):
            raise exc.reason from exc
        raise OSError(str(exc.reason)) from exc


class ServiceClient:
    def __init__(
        self,
        data_dir: Path,
        *,
        connect: Callable[[Path], Discovered] = ensure_running,
        send: Send = urllib_send,
    ) -> None:
        self._data_dir = data_dir
        self._connect = connect
        self._send = send
        self._lock = threading.Lock()
        self._found: Discovered | None = None

    def _service(self, *, refresh: bool = False) -> Discovered:
        with self._lock:
            if refresh or self._found is None:
                try:
                    self._found = self._connect(self._data_dir)
                except AppError as exc:
                    raise BridgeError.of(exc.code, exc.message) from exc
            return self._found

    def request(
        self,
        method: str,
        path: str,
        *,
        body: object = None,
        query: Mapping[str, str] | None = None,
    ) -> Any:
        """Call the local API and return decoded JSON (``None`` for 204)."""
        target = path + ("?" + urllib.parse.urlencode(query) if query else "")
        payload = None if body is None else json.dumps(body).encode("utf-8")
        response = self._attempt(method, target, payload, refresh=False)
        if response is None or response.status == 401:
            response = self._attempt(method, target, payload, refresh=True)
        if response is None:
            raise BridgeError.of(
                ErrorCode.SERVICE_UNAVAILABLE, "the local service is not reachable"
            )
        return _decode(response)

    def _attempt(
        self, method: str, target: str, payload: bytes | None, *, refresh: bool
    ) -> Response | None:
        found = self._service(refresh=refresh)
        headers = {"Authorization": f"Bearer {found.token}", "Accept": "application/json"}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        try:
            return self._send(
                method, found.endpoint.base_url + target, headers, payload, REQUEST_TIMEOUT_S
            )
        except TimeoutError as exc:
            raise BridgeError.of(
                ErrorCode.TIMEOUT, "the local service did not answer in time"
            ) from exc
        except OSError:
            return None


def quote_id(value: str) -> str:
    """Encode one path segment so an id can never address another route."""
    return urllib.parse.quote(value, safe="")


def _decode(response: Response) -> Any:
    if response.status == 204 or not response.body:
        if response.status < 400:
            return None
        raise BridgeError.of(ErrorCode.INTERNAL, f"the local service failed ({response.status})")
    try:
        data = json.loads(response.body)
    except ValueError as exc:
        raise BridgeError.of(ErrorCode.INTERNAL, "the local service sent an invalid reply") from exc
    if response.status < 400:
        return data
    try:
        error = ErrorBody.model_validate(data)
    except ValueError as exc:
        raise BridgeError.of(
            ErrorCode.INTERNAL, f"the local service failed ({response.status})"
        ) from exc
    raise BridgeError(error)
