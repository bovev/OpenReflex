"""Adapter tests against real Laya weights.

Run with ``py scripts/laya_compat/run.py pytest``: Linux container, cached
typed-decisions weights. Skipped unless ``--real-model`` is given.
"""

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from openreflex.domain.decision import WarningCode
from openreflex.domain.errors import AppError, ErrorCode
from openreflex.domain.recipe import ModelProfile, Recipe
from openreflex.laya_adapter import LayaAdapter
from openreflex.models.catalog import CATALOG
from openreflex.models.types import InstalledModel
from openreflex.recipes.store import bundled_examples, parse_recipe_text

pytestmark = pytest.mark.real_model

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "laya" / "typed-decisions.json").read_text(
        encoding="utf-8"
    )
)


class CachedLocator:
    """Finds already-downloaded checkpoints in the Hugging Face cache; never downloads."""

    def locate(self, profile: ModelProfile) -> InstalledModel:
        from huggingface_hub import snapshot_download

        cp = CATALOG[profile]
        try:
            root = snapshot_download(
                cp.repo_id,
                revision=cp.revision,
                allow_patterns=[cp.repo_path(f) for f in cp.files],
                local_files_only=True,
            )
        except Exception as exc:
            raise AppError(ErrorCode.MODEL_NOT_READY, f"{profile.value} not cached") from exc
        path = Path(root) / cp.subfolder if cp.subfolder else Path(root)
        return InstalledModel(checkpoint=cp, path=path)


@pytest.fixture(scope="module")
def adapter() -> LayaAdapter:
    return LayaAdapter(CachedLocator())


def recipe(questions: dict[str, Any]) -> Recipe:
    return Recipe.model_validate(
        {"schema_version": 1, "id": "real", "name": "Real", "questions": questions}
    )


def test_fixture_replays_within_tolerance(adapter: LayaAdapter) -> None:
    result = adapter.predict(FIXTURE["request"]["state"], recipe(FIXTURE["request"]["questions"]))
    expected = FIXTURE["response"]["answers"]
    dept = result.outputs["department"]
    assert dept.type == "choice"
    for k, p in expected["department"]["probabilities"].items():
        assert dept.probabilities[k] == pytest.approx(p, abs=2e-3)
    urgent = result.outputs["urgent"]
    assert urgent.type == "noul"
    assert urgent.probability_true == pytest.approx(expected["urgent"]["noul"], abs=2e-3)
    pri = result.outputs["priority"]
    assert pri.type == "score"
    assert pri.expected == pytest.approx(expected["priority"]["score"], abs=5e-3)
    assert result.warnings == []
    assert result.model.checkpoint == "convaiinnovations/laya/typed-decisions"


def test_no_stdout_from_upstream(adapter: LayaAdapter, capfd: pytest.CaptureFixture[str]) -> None:
    adapter.unload()
    adapter.predict({"text": "hello"}, recipe({"q": {"type": "noul", "instructions": "Hi?"}}))
    assert capfd.readouterr().out == ""


def test_long_input_reports_truncation(adapter: LayaAdapter) -> None:
    result = adapter.predict(
        {"text": "Refund request. " * 2000},
        recipe({"q": {"type": "noul", "instructions": "Urgent?"}}),
    )
    assert [w.code for w in result.warnings] == [WarningCode.INPUT_TRUNCATED]


def test_input_just_under_budget_is_not_flagged(adapter: LayaAdapter) -> None:
    result = adapter.predict(
        {"text": "Refund request. " * 150},
        recipe({"q": {"type": "noul", "instructions": "Urgent?"}}),
    )
    assert result.warnings == []


def test_long_options_and_instructions_are_flagged(adapter: LayaAdapter) -> None:
    long = "a very detailed and wordy description of this option " * 5
    r = recipe(
        {
            "d": {
                "type": "choice",
                "instructions": "Please decide carefully which team fits best. " * 20,
                "criteria": {f"opt-{i}": long[:290] for i in range(12)},
            }
        }
    )
    codes = {w.code for w in adapter.predict({"text": "short"}, r).warnings}
    assert WarningCode.OPTIONS_TRUNCATED in codes
    assert WarningCode.INSTRUCTIONS_TRUNCATED in codes


def test_bundled_examples_run_without_false_warnings(adapter: LayaAdapter) -> None:
    for text in bundled_examples():
        r = parse_recipe_text(text)
        result = adapter.predict({"text": "Hello, I have a question about my invoice."}, r)
        assert result.warnings == [], r.id
        assert set(result.outputs) == set(r.questions)


def test_router_is_metadata_only() -> None:
    from openreflex.laya_adapter._upstream import import_upstream

    up = import_upstream()
    assert up.route({"text": "I was charged twice"}, {}) == "english"
    # Non-Latin script is upstream's primary routing signal. Short Latin-script
    # non-English text can be detected as English (upstream heuristic).
    assert up.route({"text": "請求書の支払いが二重に請求されました"}, {}) == "multilingual"
