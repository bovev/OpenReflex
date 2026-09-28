"""Service-level decision tests. No network, no model downloads, no Laya."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from openreflex.decisions import DecisionService
from openreflex.domain.decision import (
    MAX_INPUT_BYTES,
    ChoiceAnswer,
    DecisionResult,
    Device,
    ModelInfo,
    NoulAnswer,
    Review,
    ScoreAnswer,
    WarningCode,
)
from openreflex.domain.engine import (
    ChoiceOutput,
    EngineResult,
    NoulOutput,
    ScoreOutput,
)
from openreflex.domain.errors import AppError, ErrorCode
from openreflex.domain.policy import evaluate
from openreflex.domain.recipe import ModelProfile, Recipe
from openreflex.engine.fake import FakeEngine, entropy_confidence
from openreflex.recipes.store import RecipeStore, parse_recipe_text

TRIAGE = """\
schema_version: 1
id: triage
name: Triage
questions:
  department:
    type: choice
    instructions: Which department?
    criteria:
      sales: Sales
      finance: Finance
      support: Support
  urgent:
    type: noul
    instructions: Urgent?
  priority:
    type: score
    instructions: Priority?
    criteria: [low, normal, high]
review_policy:
  default_min_confidence: 0.6
"""


@pytest.fixture
def recipe() -> Recipe:
    return parse_recipe_text(TRIAGE)


@pytest.fixture
def engine() -> FakeEngine:
    return FakeEngine()


@pytest.fixture
def service(tmp_path: Path, recipe: Recipe, engine: FakeEngine) -> DecisionService:
    store = RecipeStore(tmp_path / "recipes")
    store.create(recipe)
    return DecisionService(store, engine)


def _codes(result: DecisionResult) -> set[WarningCode]:
    return {w.code for w in result.warnings}


def test_completed_decision_has_every_answer(service: DecisionService) -> None:
    result = service.run("triage", "Please refund invoice 44 [fake:high]")
    assert result.status == "completed"
    assert result.contract_version == 1
    assert isinstance(result.answers["department"], ChoiceAnswer)
    assert isinstance(result.answers["urgent"], NoulAnswer)
    assert isinstance(result.answers["priority"], ScoreAnswer)
    assert result.model.device is Device.FAKE
    assert result.model.checkpoint == "fake/typed-decisions"
    assert result.review is Review.OK
    assert _codes(result) == {WarningCode.SCORE_WEAK}
    assert len(result.request_id) == 36


def test_is_deterministic(service: DecisionService) -> None:
    a = service.run("triage", {"subject": "Invoice", "body": "charged twice"}, request_id="r1")
    b = service.run("triage", {"subject": "Invoice", "body": "charged twice"}, request_id="r1")
    assert a.answers == b.answers


def test_low_confidence_needs_review(service: DecisionService) -> None:
    result = service.run("triage", "something vague [fake:low]")
    assert result.review is Review.NEEDS_REVIEW
    low = [w for w in result.warnings if w.code is WarningCode.LOW_CONFIDENCE]
    assert {w.question_id for w in low} == {"department", "urgent", "priority"}
    assert all(a.review is Review.NEEDS_REVIEW for a in result.answers.values())


def test_truncation_forces_review_even_when_confident(service: DecisionService) -> None:
    result = service.run("triage", "long mail [fake:high] [fake:truncate]")
    assert all(a.review is Review.OK for a in result.answers.values())
    assert WarningCode.INPUT_TRUNCATED in _codes(result)
    assert result.review is Review.NEEDS_REVIEW


@pytest.mark.parametrize(
    ("marker", "code"),
    [
        ("[fake:fail]", ErrorCode.ENGINE_FAILURE),
        ("[fake:incompatible]", ErrorCode.ENGINE_INCOMPATIBLE),
    ],
)
def test_engine_failures_are_stable_errors(
    service: DecisionService, marker: str, code: ErrorCode
) -> None:
    with pytest.raises(AppError) as info:
        service.run("triage", f"x {marker}")
    assert info.value.code is code


def test_unexpected_engine_exception_is_sanitized(service: DecisionService) -> None:
    def explode(*_: object) -> EngineResult:
        raise RuntimeError("tensor mismatch near 'customer secret text'")

    service.engine.predict = explode  # type: ignore[method-assign]
    with pytest.raises(AppError) as info:
        service.run("triage", "customer secret text")
    assert info.value.code is ErrorCode.ENGINE_FAILURE
    assert "secret" not in info.value.message


def test_model_not_ready(tmp_path: Path, recipe: Recipe) -> None:
    store = RecipeStore(tmp_path / "r")
    store.create(recipe)
    svc = DecisionService(store, FakeEngine(ready_profiles=[ModelProfile.ENGLISH]))
    with pytest.raises(AppError) as info:
        svc.run("triage", "hello")
    assert info.value.code is ErrorCode.MODEL_NOT_READY


def test_unknown_recipe(service: DecisionService) -> None:
    with pytest.raises(AppError) as info:
        service.run("nope", "hello")
    assert info.value.code is ErrorCode.RECIPE_NOT_FOUND


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ("", ErrorCode.INVALID_INPUT),
        (["a"], ErrorCode.INVALID_INPUT),
        pytest.param("x" * MAX_INPUT_BYTES, ErrorCode.INPUT_TOO_LARGE, id="too-large"),
    ],
)
def test_bad_input(service: DecisionService, raw: object, code: ErrorCode) -> None:
    with pytest.raises(AppError) as info:
        service.run("triage", raw)
    assert info.value.code is code


def test_model_is_loaded_once(service: DecisionService, engine: FakeEngine) -> None:
    for i in range(5):
        service.run("triage", f"message {i}")
    assert engine.load_count == 1
    assert engine.predict_count == 5
    assert engine.status().loaded_profile is ModelProfile.TYPED_DECISIONS
    engine.unload()
    assert engine.status().loaded_profile is None


def test_auto_profile_reports_resolved_model(tmp_path: Path) -> None:
    store = RecipeStore(tmp_path / "r")
    store.create(parse_recipe_text(TRIAGE.replace("name: Triage", "name: T\nmodel_profile: auto")))
    result = DecisionService(store, FakeEngine()).run("triage", "hi")
    assert result.model.profile is ModelProfile.AUTO
    assert result.model.resolved_profile is ModelProfile.ENGLISH
    assert WarningCode.EXPERIMENTAL_ROUTING in _codes(result)


# -- policy with hand-built engine output ------------------------------------

INFO = ModelInfo(
    profile=ModelProfile.TYPED_DECISIONS,
    resolved_profile=ModelProfile.TYPED_DECISIONS,
    checkpoint="test",
    revision="r",
    device=Device.CPU,
)


def _result(**outputs: object) -> EngineResult:
    base: dict[str, object] = {
        "department": ChoiceOutput(
            probabilities={"sales": 0.1, "finance": 0.8, "support": 0.1}, confidence=0.6
        ),
        "urgent": NoulOutput(probability_true=0.3, confidence=0.7),
        "priority": ScoreOutput(probabilities=[0.2, 0.3, 0.5], expected=1.3, confidence=0.4),
    }
    base.update(outputs)
    return EngineResult.model_validate({"model": INFO, "outputs": base})


def test_policy_maps_each_primitive(recipe: Recipe) -> None:
    result = evaluate(recipe, _result(), request_id="r", timing_ms=12.345)
    dept = result.answers["department"]
    assert isinstance(dept, ChoiceAnswer)
    assert (dept.choice, dept.probability, dept.review) == ("finance", 0.8, Review.OK)
    urgent = result.answers["urgent"]
    assert isinstance(urgent, NoulAnswer)
    assert urgent.value is False and urgent.review is Review.OK
    pri = result.answers["priority"]
    assert isinstance(pri, ScoreAnswer)
    assert (pri.level, pri.label, pri.probability) == (2, "high", 0.5)
    assert pri.review is Review.NEEDS_REVIEW  # 0.4 < 0.6
    assert result.review is Review.NEEDS_REVIEW
    assert result.timing_ms == 12.3


def test_policy_threshold_is_inclusive_and_per_question(recipe: Recipe) -> None:
    data = recipe.model_dump(mode="json")
    data["questions"]["priority"]["min_confidence"] = 0.4
    custom = Recipe.model_validate(data)
    result = evaluate(custom, _result(), request_id="r", timing_ms=1)
    assert result.answers["priority"].review is Review.OK
    assert result.review is Review.OK


def test_policy_ties_pick_first_option(recipe: Recipe) -> None:
    tie = ChoiceOutput(probabilities={"support": 0.4, "sales": 0.4, "finance": 0.2}, confidence=0.9)
    answer = evaluate(recipe, _result(department=tie), request_id="r", timing_ms=1).answers[
        "department"
    ]
    assert isinstance(answer, ChoiceAnswer) and answer.choice == "sales"
    assert list(answer.probabilities) == ["sales", "finance", "support"]


def test_policy_noul_boundary(recipe: Recipe) -> None:
    out = NoulOutput(probability_true=0.5, confidence=0.5)
    answer = evaluate(recipe, _result(urgent=out), request_id="r", timing_ms=1).answers["urgent"]
    assert isinstance(answer, NoulAnswer) and answer.value is True


@pytest.mark.parametrize(
    "outputs",
    [
        {"department": NoulOutput(probability_true=0.5, confidence=0.5)},
        {"department": ChoiceOutput(probabilities={"sales": 0.5, "other": 0.5}, confidence=0.1)},
        {"priority": ScoreOutput(probabilities=[0.5, 0.5], expected=0.5, confidence=0.1)},
    ],
)
def test_policy_rejects_mismatched_output(recipe: Recipe, outputs: dict[str, object]) -> None:
    with pytest.raises(AppError) as info:
        evaluate(recipe, _result(**outputs), request_id="r", timing_ms=1)
    assert info.value.code is ErrorCode.ENGINE_INCOMPATIBLE


def test_policy_rejects_missing_or_extra_questions(recipe: Recipe) -> None:
    good = _result()
    missing = EngineResult(
        model=INFO, outputs={k: v for k, v in good.outputs.items() if k != "urgent"}
    )
    with pytest.raises(AppError):
        evaluate(recipe, missing, request_id="r", timing_ms=1)
    extra = EngineResult(
        model=INFO, outputs={**good.outputs, "bonus": NoulOutput(probability_true=1, confidence=1)}
    )
    with pytest.raises(AppError):
        evaluate(recipe, extra, request_id="r", timing_ms=1)


def test_engine_outputs_reject_non_distributions() -> None:
    with pytest.raises(ValueError):
        ChoiceOutput(probabilities={"a": 0.9, "b": 0.9}, confidence=0.5)
    with pytest.raises(ValueError):
        ScoreOutput(probabilities=[0.1, 0.1], expected=0.5, confidence=0.5)
    with pytest.raises(ValueError):
        NoulOutput(probability_true=1.2, confidence=0.5)


def test_warnings_are_deduplicated(recipe: Recipe) -> None:
    dup = _result()
    dup = dup.model_copy(
        update={
            "warnings": [
                *dup.warnings,
                *evaluate(recipe, dup, request_id="r", timing_ms=1).warnings,
            ]
        }
    )
    result = evaluate(recipe, dup, request_id="r", timing_ms=1)
    keys = [(w.code, w.question_id) for w in result.warnings]
    assert len(keys) == len(set(keys))


def test_entropy_confidence() -> None:
    assert entropy_confidence([1.0]) == 1.0
    assert entropy_confidence([0.5, 0.5]) == pytest.approx(0.0)
    assert entropy_confidence([1.0, 0.0]) == pytest.approx(1.0)


def test_service_does_not_import_laya() -> None:
    assert "laya" not in sys.modules
