"""Endpoint behaviour with the fake engine. No model downloads or network."""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from openreflex.context import AppContext
from openreflex.domain.recipe import ModelProfile
from openreflex.engine.fake import FakeEngine

from .conftest import client_for, make_context

RECIPE: dict[str, Any] = {
    "schema_version": 1,
    "id": "my-recipe",
    "name": "Mine",
    "questions": {"urgent": {"type": "noul", "instructions": "Urgent?"}},
}


def test_status(client: TestClient) -> None:
    body = client.get("/v1/status").json()
    assert body["product"] == "OpenReflex"
    assert "Powered by Laya" in body["attribution"]
    assert body["offline_ready"] is False
    assert body["engine"]["engine"] == "fake"
    assert {m["profile"] for m in body["models"]} == {"typed-decisions", "english", "multilingual"}
    assert body["history"]["enabled"] is False
    assert "never stored" in body["history"]["what_is_stored"]


def test_examples_are_seeded(client: TestClient) -> None:
    listing = client.get("/v1/recipes").json()
    assert {r["id"] for r in listing["recipes"]} == {
        "email-triage",
        "support-routing",
        "document-review",
        "sales-lead-categorization",
    }
    assert all(r["example"] for r in listing["recipes"])


def test_recipe_crud(client: TestClient) -> None:
    assert client.post("/v1/recipes", json=RECIPE).status_code == 201
    assert client.post("/v1/recipes", json=RECIPE).json()["code"] == "recipe_exists"
    assert client.get("/v1/recipes/my-recipe").json()["name"] == "Mine"
    changed = {**RECIPE, "name": "Changed"}
    assert client.put("/v1/recipes/my-recipe", json=changed).json()["name"] == "Changed"
    wrong_id = client.put("/v1/recipes/my-recipe", json={**RECIPE, "id": "other"})
    assert wrong_id.status_code == 422
    assert client.put("/v1/recipes/absent", json={**RECIPE, "id": "absent"}).status_code == 404
    assert client.delete("/v1/recipes/my-recipe").json()["code"] == "confirmation_required"
    assert client.delete("/v1/recipes/my-recipe?confirm=wrong").status_code == 400
    assert client.delete("/v1/recipes/my-recipe?confirm=my-recipe").status_code == 204
    assert client.get("/v1/recipes/my-recipe").status_code == 404
    assert client.delete("/v1/recipes/my-recipe?confirm=my-recipe").status_code == 404


def test_invalid_recipe_reports_issues(client: TestClient) -> None:
    response = client.post("/v1/recipes", json={**RECIPE, "id": "Bad Id", "typo": 1})
    body = response.json()
    assert response.status_code == 422 and body["code"] == "invalid_recipe"
    assert {i["location"] for i in body["issues"]} >= {"id", "typo"}


@pytest.mark.parametrize(
    "path",
    ["/v1/recipes/..%2F..%2Fsecret", "/v1/recipes/%2e%2e", "/v1/recipes/C:%5Cx", "/v1/recipes/UP"],
)
def test_traversal_ids_are_not_found(client: TestClient, path: str) -> None:
    assert client.get(path).status_code == 404


def test_validate_json_and_yaml(client: TestClient) -> None:
    ok = client.post("/v1/recipes/validate", json={"recipe": RECIPE}).json()
    assert ok["valid"] is True and ok["recipe"]["id"] == "my-recipe"
    bad = client.post(
        "/v1/recipes/validate", json={"recipe": {**RECIPE, "schema_version": 2}}
    ).json()
    assert bad["valid"] is False and bad["issues"]
    yaml_ok = client.post(
        "/v1/recipes/validate", json={"yaml": client.get("/v1/recipes/email-triage/export").text}
    ).json()
    assert yaml_ok["valid"] is True
    assert {w["code"] for w in yaml_ok["warnings"]} == {"score_weak"}
    alias = client.post("/v1/recipes/validate", json={"yaml": "a: &x 1\nb: *x\n"}).json()
    assert alias["valid"] is False and alias["issues"][0]["location"] == "yaml"
    both = client.post("/v1/recipes/validate", json={"recipe": RECIPE, "yaml": "x: 1"})
    assert both.status_code == 422
    assert client.post("/v1/recipes/validate", json={}).status_code == 422
    assert client.get("/v1/recipes").json()["recipes"]  # validation never saved anything
    assert client.get("/v1/recipes/my-recipe").status_code == 404


def test_import_export_round_trip(client: TestClient) -> None:
    exported = client.get("/v1/recipes/email-triage/export")
    assert exported.headers["content-type"].startswith("application/yaml")
    assert "attachment" in exported.headers["content-disposition"]
    text = exported.text.replace("id: email-triage", "id: triage-copy")
    assert client.post("/v1/recipes/import", json={"yaml": text}).status_code == 201
    assert client.post("/v1/recipes/import", json={"yaml": text}).status_code == 409
    renamed = text.replace("Email triage (example)", "Copy")
    assert (
        client.post("/v1/recipes/import", json={"yaml": renamed, "overwrite": True}).json()["name"]
        == "Copy"
    )


def test_decision(client: TestClient) -> None:
    response = client.post(
        "/v1/decisions", json={"recipe_id": "email-triage", "input": "Refund invoice 12"}
    )
    body = response.json()
    assert response.status_code == 200
    assert body["status"] == "completed" and body["contract_version"] == 1
    assert set(body["answers"]) == {"department", "urgent", "priority"}
    assert body["request_id"] == response.headers["x-request-id"]
    assert body["model"]["device"] == "fake"
    json_input = client.post(
        "/v1/decisions", json={"recipe_id": "email-triage", "input": {"subject": "Hi"}}
    )
    assert json_input.status_code == 200


@pytest.mark.parametrize(
    ("payload", "status", "code"),
    [
        ({"recipe_id": "nope", "input": "x"}, 404, "recipe_not_found"),
        ({"recipe_id": "email-triage", "input": ""}, 422, "invalid_input"),
        ({"recipe_id": "email-triage", "input": ["x"]}, 422, "invalid_input"),
        ({"recipe_id": "email-triage", "input": "x", "path": "C:/x"}, 422, "invalid_input"),
        ({"recipe_id": "email-triage", "url": "https://x"}, 422, "invalid_input"),
        ({"recipe_id": "email-triage", "input": "x [fake:fail]"}, 500, "engine_failure"),
    ],
)
def test_decision_errors(
    client: TestClient, payload: dict[str, Any], status: int, code: str
) -> None:
    response = client.post("/v1/decisions", json=payload)
    assert (response.status_code, response.json()["code"]) == (status, code)


def test_input_too_large_for_decision(client: TestClient) -> None:
    response = client.post(
        "/v1/decisions", json={"recipe_id": "email-triage", "input": "a" * 200_000}
    )
    assert (response.status_code, response.json()["code"]) == (413, "input_too_large")


def test_model_not_ready(tmp_path: Path) -> None:
    ctx = make_context(tmp_path, engine=FakeEngine(ready_profiles=[]))
    with client_for(ctx) as c:
        response = c.post("/v1/decisions", json={"recipe_id": "email-triage", "input": "x"})
    assert (response.status_code, response.json()["code"]) == (409, "model_not_ready")


def test_queue_full_returns_429(tmp_path: Path) -> None:
    ctx = make_context(tmp_path, engine=FakeEngine(delay_s=0.5), queue_size=1)
    results: list[int] = []
    with client_for(ctx) as c:

        def call() -> None:
            r = c.post("/v1/decisions", json={"recipe_id": "email-triage", "input": "slow"})
            results.append(r.status_code)
            if r.status_code == 429:
                assert r.headers["retry-after"] == "2"
                assert r.json()["code"] == "queue_full"

        threads = [threading.Thread(target=call) for _ in range(4)]
        for t in threads:
            t.start()
            time.sleep(0.02)
        for t in threads:
            t.join()
    assert results.count(200) >= 1 and 429 in results
    ctx.close()


def test_timeout_returns_504_and_queue_recovers(tmp_path: Path) -> None:
    ctx = make_context(tmp_path, engine=FakeEngine(delay_s=0.4), inference_timeout_s=0.05)
    with client_for(ctx) as c:
        slow = c.post("/v1/decisions", json={"recipe_id": "email-triage", "input": "x"})
        assert (slow.status_code, slow.json()["code"]) == (504, "timeout")
        deadline = time.time() + 5
        while ctx.queue.depth and time.time() < deadline:
            time.sleep(0.05)
        assert ctx.queue.depth == 0
    ctx.close()


def test_single_engine_instance_shared(client: TestClient, ctx: AppContext) -> None:
    for i in range(3):
        client.post("/v1/decisions", json={"recipe_id": "email-triage", "input": f"m{i}"})
    engine = ctx.engine
    assert isinstance(engine, FakeEngine) and engine.load_count == 1


def test_models_download_status_and_removal(client: TestClient, ctx: AppContext) -> None:
    models = {m["profile"]: m for m in client.get("/v1/models").json()}
    assert models["typed-decisions"]["state"] == "not_installed"
    started = client.post("/v1/models/typed-decisions/download")
    assert started.status_code == 202
    ctx.downloads.wait(ModelProfile.TYPED_DECISIONS, timeout=10)
    status = client.get("/v1/status").json()
    assert status["offline_ready"] is True
    assert client.get("/health/ready").json()["ready"] is True
    assert client.post("/v1/models/typed-decisions/verify").json()["state"] == "installed"
    assert client.delete("/v1/models/typed-decisions").status_code == 400
    removed = client.delete("/v1/models/typed-decisions?confirm=typed-decisions")
    assert removed.json()["state"] == "not_installed"
    assert client.post("/v1/models/unknown/download").status_code == 422


def test_remove_unloads_engine(client: TestClient, ctx: AppContext) -> None:
    client.post("/v1/models/typed-decisions/download")
    ctx.downloads.wait(ModelProfile.TYPED_DECISIONS, timeout=10)
    client.post("/v1/decisions", json={"recipe_id": "email-triage", "input": "x"})
    assert ctx.engine.status().loaded_profile is ModelProfile.TYPED_DECISIONS
    client.delete("/v1/models/typed-decisions?confirm=typed-decisions")
    assert ctx.engine.status().loaded_profile is None


def test_history_opt_in(client: TestClient) -> None:
    assert client.get("/v1/history").json()["code"] == "history_disabled"
    client.post("/v1/decisions", json={"recipe_id": "email-triage", "input": "before opt-in"})
    assert client.put("/v1/preferences", json={"history_enabled": True}).json() == {
        "history_enabled": True
    }
    assert client.get("/v1/preferences").json()["history_enabled"] is True
    secret = "Private text 4471 about a refund"
    client.post("/v1/decisions", json={"recipe_id": "email-triage", "input": secret})
    page = client.get("/v1/history")
    entries = page.json()["entries"]
    assert len(entries) == 1 and entries[0]["recipe_id"] == "email-triage"
    assert set(entries[0]["answers"]) == {"department", "urgent", "priority"}
    assert "4471" not in page.text and "Private" not in page.text
    assert client.delete("/v1/history").status_code == 204
    assert client.get("/v1/history").json()["entries"] == []
    assert client.put("/v1/preferences", json={"history_enabled": "yes please"}).status_code == 422
    assert client.put("/v1/preferences", json={"telemetry": True}).status_code == 422
