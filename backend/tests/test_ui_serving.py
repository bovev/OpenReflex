"""Serving the built UI: static assets, security headers, cache behavior.

The production build (``frontend/dist``) is mounted by the service with the
same trust boundary as the API: loopback Host/Origin checks, bearer token for
everything except the UI itself, no-store for the bootstrap document and every
API response, and a CSP without ``unsafe-inline`` or external origins.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from openreflex.api.app import create_app, secured
from openreflex.context import AppContext, build_context
from openreflex.settings import ServiceSettings

PORT = 47821


@pytest.fixture
def ui_dir(tmp_path: Path) -> Path:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(
        "<!doctype html><html><head>"
        '<link rel="stylesheet" href="/assets/style.css">'
        '<script type="module" src="/assets/app.js"></script>'
        '</head><body><div id="root"></div></body></html>',
        encoding="utf-8",
    )
    (dist / "assets" / "app.js").write_text("export {}", encoding="utf-8")
    (dist / "assets" / "style.css").write_text("body { margin: 0 }", encoding="utf-8")
    return dist


@pytest.fixture
def ctx(tmp_path: Path) -> Iterator[AppContext]:
    settings = ServiceSettings(data_dir=tmp_path / "data", port=PORT, engine="fake")
    context = build_context(settings)
    yield context
    context.close()


@pytest.fixture
def http(ctx: AppContext, ui_dir: Path) -> Iterator[TestClient]:
    with TestClient(
        secured(ctx, create_app(ctx, ui_dir=ui_dir)), base_url=f"http://127.0.0.1:{PORT}"
    ) as client:  # type: ignore[arg-type]
        yield client


def _auth(ctx: AppContext) -> dict[str, str]:
    return {"Authorization": f"Bearer {ctx.token}"}


def test_bootstrap_document_is_served_without_a_token(ctx: AppContext, http: TestClient) -> None:
    reply = http.get("/")
    assert reply.status_code == 200
    assert reply.headers["content-type"].startswith("text/html")
    assert reply.text.startswith("<!doctype html>")


def test_bootstrap_document_and_api_responses_are_never_cached(
    ctx: AppContext, http: TestClient
) -> None:
    for path in ("/", "/index.html", "/health/live"):
        reply = http.get(path)
        assert reply.status_code == 200, path
        assert reply.headers["cache-control"] == "no-store", path
    reply = http.get("/v1/status", headers=_auth(ctx))
    assert reply.status_code == 200
    assert reply.headers["cache-control"] == "no-store"
    denied = http.get("/v1/status")
    assert denied.status_code == 401
    assert denied.headers["cache-control"] == "no-store"


def test_hashed_assets_are_served_and_may_be_cached(http: TestClient) -> None:
    reply = http.get("/assets/app.js")
    assert reply.status_code == 200
    assert reply.text == "export {}"
    assert reply.headers.get("cache-control") != "no-store"
    css = http.get("/assets/style.css")
    assert css.status_code == 200


def test_csp_has_no_unsafe_inline_or_external_origins(http: TestClient) -> None:
    csp = http.get("/").headers["content-security-policy"]
    assert "unsafe-inline" not in csp
    assert "unsafe-eval" not in csp
    assert "http://" not in csp
    assert "https://" not in csp
    assert "'self'" in csp


def test_served_ui_references_only_local_assets(http: TestClient) -> None:
    # No external runtime requests: the bootstrap document and its assets
    # point only at same-origin paths.
    for path in ("/", "/assets/app.js", "/assets/style.css"):
        text = http.get(path).text
        for marker in ("http://", "https://", "//cdn.", "//fonts."):
            assert marker not in text, path


def test_api_error_envelope_is_stable_and_token_free(ctx: AppContext, http: TestClient) -> None:
    denied = http.get("/v1/status")
    assert denied.status_code == 401
    body = denied.json()
    assert body["code"] == "unauthorized"
    assert body["message"] == "missing or invalid token"
    assert len(body["request_id"]) == 36
    assert ctx.token not in denied.text

    allowed = http.get("/v1/status", headers=_auth(ctx))
    assert allowed.status_code == 200
    assert allowed.json()["product"] == "OpenReflex"


def test_without_a_ui_build_there_is_no_ui_fallback(ctx: AppContext) -> None:
    with TestClient(
        secured(ctx, create_app(ctx)), base_url=f"http://127.0.0.1:{PORT}"
    ) as client:  # type: ignore[arg-type]
        reply = client.get("/")
    assert reply.status_code == 404
    assert reply.json()["code"] == "not_found"
