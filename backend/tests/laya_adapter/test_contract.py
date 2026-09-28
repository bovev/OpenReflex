"""Adapter contract tests against a fake upstream replaying captured Laya output.

These run everywhere (no torch). ``test_real_model.py`` checks the same
behaviour against real weights inside the compatibility container.
"""

from __future__ import annotations

import copy
import io
import json
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from openreflex.decisions import DecisionService
from openreflex.domain.decision import ChoiceAnswer, Device, NoulAnswer, ScoreAnswer, WarningCode
from openreflex.domain.errors import AppError, ErrorCode
from openreflex.domain.recipe import ModelProfile, Recipe
from openreflex.laya_adapter import LayaAdapter
from openreflex.laya_adapter._upstream import SUPPORTED_VERSION, Tokenizer
from openreflex.laya_adapter.normalize import normalize_answers
from openreflex.laya_adapter.translate import to_laya_questions
from openreflex.models.catalog import CATALOG
from openreflex.models.types import InstalledModel
from openreflex.recipes.store import RecipeStore

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "laya" / "typed-decisions.json").read_text(
        encoding="utf-8"
    )
)


def fixture_recipe() -> Recipe:
    return Recipe.model_validate(
        {
            "schema_version": 1,
            "id": "fixture",
            "name": "Fixture",
            "questions": FIXTURE["request"]["questions"],
            "review_policy": {"default_min_confidence": 0.3},
        }
    )


class FakeTok:
    mask_token = "[MASK]"

    def __call__(self, text: str, *, add_special_tokens: bool = False) -> Mapping[str, Any]:
        return {"input_ids": list(range(len(text.split())))}


class FakeAgent:
    def __init__(self, response: Mapping[str, Any], max_len: int = 1024) -> None:
        self.tok: Tokenizer = FakeTok()
        self.cfg: Mapping[str, Any] = {"max_len": max_len, "head_max_len": 64}
        self.device: Any = type("D", (), {"type": "cpu"})()
        self.response = response
        self.calls: list[tuple[Any, Mapping[str, Any]]] = []

    def predict(self, state: Any, questions: Mapping[str, Any]) -> Mapping[str, Any]:
        print("laya noise on stdout")  # upstream prints; must not reach stdout
        self.calls.append((state, questions))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


class FakeUpstream:
    """Mimics the sequence layout: [CLS] head [SEP] ([MASK] opt)* [SEP] state [SEP]."""

    def __init__(
        self, agent: FakeAgent, version: str = SUPPORTED_VERSION, route_to: str = "english"
    ):
        self.version = version
        self.agent = agent
        self.route_to = route_to
        self.loads: list[str] = []

    def load(self, path: str, device: str) -> FakeAgent:
        print("loading noise")
        self.loads.append(path)
        return self.agent

    def route(self, state: Any, questions: Mapping[str, Any]) -> str:
        return self.route_to

    def to_internal(self, question: Mapping[str, Any]) -> Mapping[str, Any]:
        return {
            "t": question["type"],
            "ins": question["instructions"],
            "crit": question.get("criteria"),
        }

    def render_options(self, q: Mapping[str, Any]) -> list[str]:
        if q["t"] == "choice":
            return [f"{k}: {v}" for k, v in q["crit"].items()]
        if q["t"] == "score":
            return [f"level {i}: {c}" for i, c in enumerate(q["crit"])]
        return ["false: no", "true: yes"]

    def serialize_state(self, state: Any) -> str:
        return state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)

    def build_sequence(
        self, tok: Tokenizer, state: Any, q: Mapping[str, Any], max_len: int, head_max_len: int
    ) -> tuple[list[int], list[int]]:
        # Per-option cap and shrink-to-fit, as documented in laya-compatibility.md.
        opts = [[0, *tok(" " + o)["input_ids"][:48]] for o in self.render_options(q)]
        head = tok(f"{q['t']} question: {q['ins']}")["input_ids"]
        budget = head_max_len - sum(len(o) for o in opts)
        if budget < 16:
            per = max(4, (head_max_len - 16) // len(opts))
            opts = [o[:per] for o in opts]
            budget = head_max_len - sum(len(o) for o in opts)
        head = head[: max(2, budget)]
        ids = [0, *head, 0]
        markers: list[int] = []
        for o in opts:
            markers.append(len(ids))
            ids.extend(o)
        ids.append(0)
        room = max(0, max_len - len(ids) - 1)
        st = tok(self.serialize_state(state))["input_ids"][:room]
        return [*ids, *st, 0], markers


class Locator:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.missing: set[ModelProfile] = set()

    def locate(self, profile: ModelProfile) -> InstalledModel:
        if profile in self.missing:
            raise AppError(ErrorCode.MODEL_NOT_READY, "not installed")
        return InstalledModel(checkpoint=CATALOG[profile], path=self.root / profile.value)


@pytest.fixture
def agent() -> FakeAgent:
    return FakeAgent(copy.deepcopy(FIXTURE["response"]))


@pytest.fixture
def upstream(agent: FakeAgent) -> FakeUpstream:
    return FakeUpstream(agent)


@pytest.fixture
def adapter(tmp_path: Path, upstream: FakeUpstream) -> LayaAdapter:
    return LayaAdapter(Locator(tmp_path), upstream_factory=lambda: upstream)


def test_translation_matches_upstream_schema() -> None:
    assert to_laya_questions(fixture_recipe()) == FIXTURE["request"]["questions"]


def test_captured_output_normalizes_for_every_primitive(adapter: LayaAdapter) -> None:
    result = adapter.predict(FIXTURE["request"]["state"], fixture_recipe())
    dept, urgent, pri = (result.outputs[k] for k in ("department", "urgent", "priority"))
    assert dept.type == "choice" and dept.probabilities["finance"] == 0.7177
    assert urgent.type == "noul" and urgent.probability_true == 0.6555
    assert pri.type == "score" and pri.probabilities == [0.0453, 0.1088, 0.4465, 0.3994]
    assert pri.expected == 2.2001
    assert result.model.checkpoint == "convaiinnovations/laya/typed-decisions"
    assert result.model.revision == CATALOG[ModelProfile.TYPED_DECISIONS].revision
    assert result.model.device is Device.CPU
    assert result.warnings == []


def test_end_to_end_through_service(tmp_path: Path, adapter: LayaAdapter) -> None:
    store = RecipeStore(tmp_path / "recipes")
    store.create(fixture_recipe())
    result = DecisionService(store, adapter).run("fixture", FIXTURE["request"]["state"])
    dept = result.answers["department"]
    assert isinstance(dept, ChoiceAnswer) and dept.choice == "finance"
    assert dept.confidence == 0.3508 and dept.probability == 0.7177
    pri = result.answers["priority"]
    assert isinstance(pri, ScoreAnswer) and (pri.level, pri.label) == (2, "high")
    assert isinstance(result.answers["urgent"], NoulAnswer)


def test_upstream_stdout_is_redirected(
    adapter: LayaAdapter, monkeypatch: pytest.MonkeyPatch
) -> None:
    out, err = io.StringIO(), io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    monkeypatch.setattr(sys, "stderr", err)
    adapter.predict(FIXTURE["request"]["state"], fixture_recipe())
    assert out.getvalue() == ""
    assert "laya noise" in err.getvalue() and "loading noise" in err.getvalue()


def test_model_loaded_once_and_passed_local_path(
    tmp_path: Path, adapter: LayaAdapter, upstream: FakeUpstream
) -> None:
    for _ in range(3):
        adapter.predict(FIXTURE["request"]["state"], fixture_recipe())
    assert upstream.loads == [str(tmp_path / "typed-decisions")]
    assert adapter.status().loaded_profile is ModelProfile.TYPED_DECISIONS
    adapter.unload()
    assert adapter.status().loaded_profile is None


def test_auto_routes_and_reports_resolved_model(tmp_path: Path, agent: FakeAgent) -> None:
    up = FakeUpstream(agent, route_to="multilingual")
    adapter = LayaAdapter(Locator(tmp_path), upstream_factory=lambda: up)
    recipe = fixture_recipe().model_copy(update={"model_profile": ModelProfile.AUTO})
    result = adapter.predict({"text": "Hallo"}, recipe)
    assert result.model.profile is ModelProfile.AUTO
    assert result.model.resolved_profile is ModelProfile.MULTILINGUAL
    assert result.model.checkpoint == "convaiinnovations/laya/multilingual"


@pytest.mark.parametrize("route_to", ["typed-decisions", "gpt-5"])
def test_auto_rejects_unexpected_routes(tmp_path: Path, agent: FakeAgent, route_to: str) -> None:
    up = FakeUpstream(agent, route_to=route_to)
    adapter = LayaAdapter(Locator(tmp_path), upstream_factory=lambda: up)
    recipe = fixture_recipe().model_copy(update={"model_profile": ModelProfile.AUTO})
    with pytest.raises(AppError) as info:
        adapter.predict({"text": "x"}, recipe)
    assert info.value.code is ErrorCode.ENGINE_INCOMPATIBLE


def test_ensure_model_auto_requires_all_candidates(tmp_path: Path, upstream: FakeUpstream) -> None:
    locator = Locator(tmp_path)
    locator.missing.add(ModelProfile.MULTILINGUAL)
    adapter = LayaAdapter(locator, upstream_factory=lambda: upstream)
    with pytest.raises(AppError) as info:
        adapter.ensure_model(ModelProfile.AUTO)
    assert info.value.code is ErrorCode.MODEL_NOT_READY
    locator.missing.clear()
    assert adapter.ensure_model(ModelProfile.AUTO).resolved_profile is ModelProfile.ENGLISH


def test_wrong_upstream_version_is_incompatible(tmp_path: Path, agent: FakeAgent) -> None:
    up = FakeUpstream(agent, version="0.4.0")
    adapter = LayaAdapter(Locator(tmp_path), upstream_factory=lambda: up)
    with pytest.raises(AppError) as info:
        adapter.ensure_model(ModelProfile.TYPED_DECISIONS)
    assert info.value.code is ErrorCode.ENGINE_INCOMPATIBLE


def test_missing_runtime_is_incompatible(tmp_path: Path) -> None:
    def missing() -> FakeUpstream:
        raise ImportError("No module named 'laya'")

    adapter = LayaAdapter(Locator(tmp_path), upstream_factory=missing)
    with pytest.raises(AppError) as info:
        adapter.ensure_model(ModelProfile.TYPED_DECISIONS)
    assert info.value.code is ErrorCode.ENGINE_INCOMPATIBLE


@pytest.mark.parametrize(
    ("exc", "code"),
    [
        (FileNotFoundError("rl_agent_config.json"), ErrorCode.ENGINE_INCOMPATIBLE),
        (ValueError("Model architecture mismatch"), ErrorCode.ENGINE_INCOMPATIBLE),
        (MemoryError(), ErrorCode.ENGINE_FAILURE),
    ],
)
def test_load_errors_become_stable_errors(
    tmp_path: Path, agent: FakeAgent, exc: BaseException, code: ErrorCode
) -> None:
    up = FakeUpstream(agent)

    def fail(path: str, device: str) -> FakeAgent:
        raise exc

    up.load = fail  # type: ignore[method-assign]
    adapter = LayaAdapter(Locator(tmp_path), upstream_factory=lambda: up)
    with pytest.raises(AppError) as info:
        adapter.ensure_model(ModelProfile.TYPED_DECISIONS)
    assert info.value.code is code


def test_option_budget_error_is_a_recipe_problem(adapter: LayaAdapter, agent: FakeAgent) -> None:
    agent.response = ValueError("question 'x' options exceed head_max_len=256")  # type: ignore[assignment]
    with pytest.raises(AppError) as info:
        adapter.predict({"text": "x"}, fixture_recipe())
    assert info.value.code is ErrorCode.INVALID_RECIPE


def test_other_predict_errors_are_sanitized(adapter: LayaAdapter, agent: FakeAgent) -> None:
    agent.response = RuntimeError("CUDA error near 'customer secret'")  # type: ignore[assignment]
    with pytest.raises(AppError) as info:
        adapter.predict({"text": "customer secret"}, fixture_recipe())
    assert info.value.code is ErrorCode.ENGINE_FAILURE
    assert "secret" not in info.value.message


# -- output compatibility -----------------------------------------------------


def _mutated(path: list[str], value: object) -> dict[str, Any]:
    response = copy.deepcopy(FIXTURE["response"])
    node = response
    for key in path[:-1]:
        node = node[key]
    if value is KeyError:
        del node[path[-1]]
    else:
        node[path[-1]] = value
    return response


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (["answers"], KeyError),
        (["answers", "urgent"], KeyError),
        (["answers", "urgent", "noul"], KeyError),
        (["answers", "urgent", "noul"], "0.6"),
        (["answers", "urgent", "noul"], float("nan")),
        (["answers", "urgent", "confidence"], True),
        (["answers", "urgent", "type"], "choice"),
        (["answers", "department", "probabilities"], KeyError),
        (["answers", "department", "probabilities", "sales"], KeyError),
        (["answers", "department", "probabilities"], [0.1, 0.9]),
        (["answers", "priority", "probabilities", "3"], KeyError),
        (["answers", "priority", "score"], KeyError),
        (["answers", "department", "confidence"], 1.7),
        (["answers", "department", "probabilities", "sales"], 0.9),
    ],
)
def test_incompatible_output_is_an_explicit_error(path: list[str], value: object) -> None:
    with pytest.raises(AppError) as info:
        normalize_answers(_mutated(path, value), fixture_recipe())
    assert info.value.code is ErrorCode.ENGINE_INCOMPATIBLE


def test_optional_and_unknown_fields_are_tolerated() -> None:
    response = _mutated(["answers", "department", "action"], KeyError)
    response: dict[str, Any] = {**response, "routing": {"model": "english"}}
    response["answers"]["priority"].pop("legend")
    response["answers"]["urgent"]["new_upstream_field"] = 1
    response.pop("usage")
    assert set(normalize_answers(response, fixture_recipe())) == {
        "department",
        "urgent",
        "priority",
    }


# -- budget warnings ----------------------------------------------------------


def test_long_input_warns_truncation(tmp_path: Path) -> None:
    agent = FakeAgent(copy.deepcopy(FIXTURE["response"]), max_len=64)
    adapter = LayaAdapter(Locator(tmp_path), upstream_factory=lambda: FakeUpstream(agent))
    result = adapter.predict({"text": "word " * 500}, fixture_recipe())
    assert [w.code for w in result.warnings] == [WarningCode.INPUT_TRUNCATED]


def test_long_options_and_instructions_warn(tmp_path: Path, agent: FakeAgent) -> None:
    long = " ".join(["detail"] * 30)
    recipe = Recipe.model_validate(
        {
            "schema_version": 1,
            "id": "long",
            "name": "Long",
            "questions": {
                "department": {
                    "type": "choice",
                    "instructions": " ".join(["please"] * 80),
                    "criteria": {k: long for k in ("sales", "finance", "support", "other")},
                },
                "urgent": {"type": "noul", "instructions": "Urgent?"},
                "priority": {
                    "type": "score",
                    "instructions": "How important?",
                    "criteria": ["low", "normal", "high", "critical"],
                },
            },
        }
    )
    adapter = LayaAdapter(Locator(tmp_path), upstream_factory=lambda: FakeUpstream(agent))
    result = adapter.predict({"text": "short"}, recipe)
    codes = {(w.code, w.question_id) for w in result.warnings}
    assert (WarningCode.OPTIONS_TRUNCATED, "department") in codes
    assert (WarningCode.INSTRUCTIONS_TRUNCATED, "department") in codes
    assert not any(qid == "urgent" for _, qid in codes)
