"""ServiceClient: discovery, retry, and error mapping without a real service."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from openreflex.domain.errors import AppError, ErrorCode
from openreflex.lifecycle.instance import Discovered
from openreflex_mcp import client as client_module
from openreflex_mcp.client import BridgeError, Response, ServiceClient, quote_id, urllib_send
from openreflex_mcp.server import call

from .conftest import discovered


class Script:
    """A fake transport replaying scripted replies and recording requests."""

    def __init__(self, *replies: Response | BaseException) -> None:
        self.replies = list(replies)
        self.requests: list[tuple[str, str, dict[str, str], bytes | None]] = []

    def __call__(
        self, method: str, url: str, headers: Mapping[str, str], body: bytes | None, timeout: float
    ) -> Response:
        self.requests.append((method, url, dict(headers), body))
        reply = self.replies.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        return reply


class Connector:
    def __init__(self, *found: Discovered | AppError) -> None:
        self.found = list(found)
        self.calls = 0

    def __call__(self, _: Path) -> Discovered:
        self.calls += 1
        item = self.found[min(self.calls, len(self.found)) - 1]
        if isinstance(item, AppError):
            raise item
        return item


def ok(data: object, status: int = 200) -> Response:
    return Response(status, json.dumps(data).encode())


def err(code: str, status: int) -> Response:
    return Response(status, json.dumps({"code": code, "message": "m", "issues": []}).encode())


def make(tmp_path: Path, script: Script, *found: Discovered | AppError) -> ServiceClient:
    return ServiceClient(
        tmp_path, connect=Connector(*found or (discovered("t" * 40),)), send=script
    )


def test_sends_token_and_json(tmp_path: Path) -> None:
    script = Script(ok({"a": 1}))
    assert make(tmp_path, script).request("POST", "/v1/x", body={"k": "v"}, query={"q": "1"}) == {
        "a": 1
    }
    method, url, headers, body = script.requests[0]
    assert (method, url) == ("POST", "http://127.0.0.1:47821/v1/x?q=1")
    assert headers["Authorization"] == "Bearer " + "t" * 40
    assert headers["Content-Type"] == "application/json"
    assert json.loads(body or b"") == {"k": "v"}


def test_connection_refused_rediscovers_once(tmp_path: Path) -> None:
    script = Script(ConnectionRefusedError(), ok({"ok": True}))
    connector = Connector(discovered("a" * 40, 1111), discovered("b" * 40, 2222))
    client = ServiceClient(tmp_path, connect=connector, send=script)
    assert client.request("GET", "/v1/status") == {"ok": True}
    assert connector.calls == 2
    assert script.requests[1][1].startswith("http://127.0.0.1:2222/")
    assert script.requests[1][2]["Authorization"] == "Bearer " + "b" * 40
    # The fresh instance is cached for later calls.
    script.replies.append(ok({}))
    client.request("GET", "/v1/status")
    assert connector.calls == 2


def test_stale_token_rediscovers_once(tmp_path: Path) -> None:
    script = Script(err("unauthorized", 401), ok([]))
    connector = Connector(discovered("a" * 40), discovered("b" * 40))
    assert ServiceClient(tmp_path, connect=connector, send=script).request("GET", "/v1/x") == []
    assert connector.calls == 2


def test_gives_up_after_one_retry(tmp_path: Path) -> None:
    script = Script(ConnectionRefusedError(), ConnectionRefusedError())
    with pytest.raises(BridgeError) as caught:
        make(tmp_path, script).request("GET", "/v1/x")
    assert caught.value.error.code is ErrorCode.SERVICE_UNAVAILABLE

    script = Script(err("unauthorized", 401), err("unauthorized", 401))
    with pytest.raises(BridgeError) as caught:
        make(tmp_path, script).request("GET", "/v1/x")
    assert caught.value.error.code is ErrorCode.UNAUTHORIZED


def test_timeout_is_not_retried(tmp_path: Path) -> None:
    script = Script(TimeoutError(), ok({}))
    with pytest.raises(BridgeError) as caught:
        make(tmp_path, script).request("POST", "/v1/decisions", body={})
    assert caught.value.error.code is ErrorCode.TIMEOUT
    assert len(script.requests) == 1


def test_service_that_cannot_start(tmp_path: Path) -> None:
    down = AppError(ErrorCode.SERVICE_UNAVAILABLE, "the local service did not start in time")
    client = ServiceClient(tmp_path, connect=Connector(down), send=Script())
    result = call(client, "list_recipes", {})
    assert result.isError
    assert result.structuredContent == {
        "error": {
            "code": "service_unavailable",
            "message": "the local service did not start in time",
            "issues": [],
        }
    }


@pytest.mark.parametrize(
    ("reply", "code"),
    [
        (Response(500, b"<html>oops</html>"), ErrorCode.INTERNAL),
        (Response(502, b'{"unexpected": true}'), ErrorCode.INTERNAL),
        (Response(500, b""), ErrorCode.INTERNAL),
        (Response(200, b"not json"), ErrorCode.INTERNAL),
        (err("queue_full", 429), ErrorCode.QUEUE_FULL),
    ],
)
def test_bad_or_error_replies_map_to_codes(
    tmp_path: Path, reply: Response, code: ErrorCode
) -> None:
    with pytest.raises(BridgeError) as caught:
        make(tmp_path, Script(reply)).request("GET", "/v1/x")
    assert caught.value.error.code is code


def test_no_content(tmp_path: Path) -> None:
    assert make(tmp_path, Script(Response(204, b""))).request("DELETE", "/v1/x") is None


def test_unexpected_bug_becomes_a_generic_tool_error(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    script = Script(ok({"recipes": [{"id": "only-id"}], "invalid": []}))
    result = call(make(tmp_path, script), "list_recipes", {})
    assert result.isError
    assert result.structuredContent == {
        "error": {"code": "internal", "message": "internal error in the MCP bridge", "issues": []}
    }
    assert "only-id" not in caplog.text


def test_quote_id_keeps_ids_in_one_segment() -> None:
    assert quote_id("../x/y?z#w") == "..%2Fx%2Fy%3Fz%23w"


def test_urllib_send_maps_http_and_network_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    class Reply:
        status = 200

        def read(self) -> bytes:
            return b"{}"

        def __enter__(self) -> Reply:
            return self

        def __exit__(self, *_: object) -> None:
            return None

    outcomes: list[Any] = [
        Reply(),
        urllib.error.HTTPError("u", 404, "nf", {}, None),  # type: ignore[arg-type]
        urllib.error.URLError(ConnectionRefusedError()),
        urllib.error.URLError(TimeoutError()),
    ]

    def fake_urlopen(request: urllib.request.Request, timeout: float) -> Any:
        outcome = outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    monkeypatch.setattr(client_module.urllib.request, "urlopen", fake_urlopen)
    assert urllib_send("GET", "http://127.0.0.1:1/x", {}, None, 1.0) == Response(200, b"{}")
    assert urllib_send("GET", "http://127.0.0.1:1/x", {}, None, 1.0).status == 404
    with pytest.raises(OSError):
        urllib_send("GET", "http://127.0.0.1:1/x", {}, None, 1.0)
    with pytest.raises(TimeoutError):
        urllib_send("GET", "http://127.0.0.1:1/x", {}, None, 1.0)
