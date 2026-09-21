"""Trust-boundary tests: auth, Host/Origin, limits, headers, loopback-only config."""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from openreflex.context import AppContext
from openreflex.security.middleware import json_log_formatter
from openreflex.security.tokens import TOKEN_FILE, load_or_create_token, token_matches
from openreflex.settings import ServiceSettings

from .conftest import PORT, make_context


def test_health_is_public(anon: TestClient) -> None:
    assert anon.get("/health/live").json() == {"status": "ok"}
    assert anon.get("/health/ready").json()["ready"] is False


@pytest.mark.parametrize("path", ["/v1/status", "/v1/recipes", "/v1/models", "/v1/history"])
def test_api_requires_token(anon: TestClient, path: str) -> None:
    response = anon.get(path)
    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


@pytest.mark.parametrize(
    "header", ["Bearer wrong-token", "Basic abc", "bearer", "", "Token {token}"]
)
def test_wrong_credentials_rejected(anon: TestClient, ctx: AppContext, header: str) -> None:
    response = anon.get("/v1/status", headers={"Authorization": header.format(token=ctx.token)})
    assert response.status_code == 401


def test_token_accepted_case_insensitive_scheme(anon: TestClient, ctx: AppContext) -> None:
    assert (
        anon.get("/v1/status", headers={"Authorization": f"bearer {ctx.token}"}).status_code == 200
    )


def test_unknown_paths_need_auth_before_404(anon: TestClient, client: TestClient) -> None:
    assert anon.get("/nope").status_code == 401
    assert client.get("/nope").json()["code"] == "not_found"


@pytest.mark.parametrize(
    "host",
    ["evil.example", f"evil.example:{PORT}", "127.0.0.1:1", "0.0.0.0:47821", "[::1]:47821", ""],
)
def test_disallowed_host_rejected(client: TestClient, host: str) -> None:
    response = client.get("/health/live", headers={"Host": host})
    assert response.status_code == 403
    assert response.json()["code"] == "forbidden"


def test_localhost_host_allowed(client: TestClient) -> None:
    assert client.get("/v1/status", headers={"Host": f"localhost:{PORT}"}).status_code == 200


@pytest.mark.parametrize(
    "origin",
    ["http://evil.example", "null", f"http://127.0.0.1:{PORT + 1}", f"https://127.0.0.1:{PORT}"],
)
def test_foreign_origin_rejected(client: TestClient, origin: str) -> None:
    response = client.get("/v1/recipes", headers={"Origin": origin})
    assert response.status_code == 403
    assert "access-control-allow-origin" not in response.headers


def test_own_origin_allowed(client: TestClient) -> None:
    assert (
        client.get("/v1/recipes", headers={"Origin": f"http://127.0.0.1:{PORT}"}).status_code == 200
    )


def test_no_cors_preflight(anon: TestClient) -> None:
    response = anon.options(
        "/v1/recipes",
        headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "GET"},
    )
    assert response.status_code == 403
    assert not any(h.startswith("access-control-") for h in response.headers)


def test_security_headers_and_request_id(client: TestClient) -> None:
    response = client.get("/v1/status")
    assert "default-src 'self'" in response.headers["content-security-policy"]
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["cache-control"] == "no-store"
    assert len(response.headers["x-request-id"]) == 36


def test_error_bodies_carry_request_id(client: TestClient) -> None:
    response = client.get("/v1/recipes/nope")
    assert response.json()["request_id"] == response.headers["x-request-id"]


def test_declared_oversized_body_rejected(client: TestClient) -> None:
    response = client.post(
        "/v1/decisions",
        content=b"{}",
        headers={"Content-Length": str(256 * 1024 + 1), "Content-Type": "application/json"},
    )
    assert response.status_code == 413


def test_streamed_oversized_body_rejected(client: TestClient) -> None:
    def chunks():  # no Content-Length: chunked transfer
        for _ in range(300):
            yield b"x" * 1024

    response = client.post(
        "/v1/decisions", content=chunks(), headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 413
    assert response.json()["code"] == "input_too_large"


def test_bad_content_length(client: TestClient) -> None:
    response = client.post("/v1/decisions", content=b"{}", headers={"Content-Length": "abc"})
    assert response.status_code == 400


def test_openapi_disabled_by_default(client: TestClient) -> None:
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_openapi_can_be_enabled(tmp_path: Path) -> None:
    from .conftest import client_for

    ctx = make_context(tmp_path, openapi=True)
    with client_for(ctx) as c:
        assert c.get("/openapi.json").status_code == 200


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.168.1.5", "localhost", "::1"])  # noqa: S104
def test_settings_refuse_non_loopback(tmp_path: Path, host: str) -> None:
    with pytest.raises(ValidationError):
        ServiceSettings(data_dir=tmp_path, host=host)


def test_token_is_persistent_random_and_private(tmp_path: Path) -> None:
    a = load_or_create_token(tmp_path)
    assert a == load_or_create_token(tmp_path)
    assert len(a) >= 32
    other = load_or_create_token(tmp_path / "other")
    assert other != a
    assert token_matches(a, a) and not token_matches(a, None) and not token_matches(a, a[:-1])
    import os
    import sys

    if sys.platform != "win32":
        assert (tmp_path / TOKEN_FILE).stat().st_mode & 0o077 == 0
    else:
        assert os.access(tmp_path / TOKEN_FILE, os.R_OK)


def test_short_token_file_is_replaced(tmp_path: Path) -> None:
    (tmp_path / TOKEN_FILE).write_text("short", encoding="utf-8")
    assert len(load_or_create_token(tmp_path)) >= 32


def test_logs_never_contain_bodies_or_tokens(
    client: TestClient, ctx: AppContext, caplog: pytest.LogCaptureFixture
) -> None:
    secret_text = "Customer SSN 123-45-6789 wants a refund"
    caplog.set_level(logging.DEBUG)
    client.post("/v1/decisions", json={"recipe_id": "email-triage", "input": secret_text})
    client.post("/v1/decisions", json={"recipe_id": "email-triage", "input": [secret_text]})
    client.post("/v1/recipes/validate", json={"yaml": f"id: [{secret_text}"})
    formatter = json_log_formatter()
    rendered = "\n".join(formatter.format(r) for r in caplog.records)
    assert rendered, "expected access log records"
    for needle in ("123-45-6789", "SSN", ctx.token, "refund"):
        assert needle not in rendered
    events = [json.loads(line) for line in rendered.splitlines()]
    assert any(e.get("route") == "/v1/decisions" and e.get("status") == 200 for e in events)
    assert any(e.get("error_code") == "invalid_input" for e in events)


def test_validation_errors_do_not_echo_input(client: TestClient) -> None:
    secret = "do-not-echo-9f8e7d"
    response = client.post("/v1/decisions", json={"recipe_id": secret.upper(), "input": 5})
    assert response.status_code == 422
    assert secret.upper() not in response.text
    response = client.post("/v1/decisions", json={"recipe_id": "x", "input": "ok", "extra": secret})
    assert response.status_code == 422 and secret not in response.text


def test_websocket_refused(client: TestClient) -> None:
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect), client.websocket_connect("/ws"):
        pass
