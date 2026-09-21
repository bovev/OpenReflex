from __future__ import annotations

import copy
from typing import Any

import pytest

from openreflex.domain.decision import WarningCode
from openreflex.domain.errors import AppError, ErrorCode
from openreflex.domain.recipe import ModelProfile, Recipe
from openreflex.domain.validation import parse_recipe, recipe_warnings, validate_recipe

EMAIL_TRIAGE: dict[str, Any] = {
    "schema_version": 1,
    "id": "email-triage",
    "name": "Email triage",
    "description": "Routes incoming messages and estimates urgency.",
    "model_profile": "typed-decisions",
    "questions": {
        "department": {
            "type": "choice",
            "instructions": "Which department should handle this request?",
            "criteria": {
                "sales": "Pricing, proposals, and new contracts",
                "finance": "Invoices, payments, and refunds",
                "support": "Product problems and technical help",
                "other": "Anything that does not fit the other categories",
            },
        },
        "urgent": {"type": "noul", "instructions": "Does this require urgent human attention?"},
        "priority": {
            "type": "score",
            "instructions": "How important is this request?",
            "criteria": ["low", "normal", "high", "critical"],
        },
    },
    "review_policy": {"default_min_confidence": 0.80, "on_low_confidence": "needs_review"},
}


def recipe(**changes: Any) -> dict[str, Any]:
    data = copy.deepcopy(EMAIL_TRIAGE)
    data.update(changes)
    return data


def with_question(qid: str, question: dict[str, Any]) -> dict[str, Any]:
    data = recipe()
    data["questions"] = {qid: question}
    return data


def choice(n: int) -> dict[str, Any]:
    return {
        "type": "choice",
        "instructions": "Pick one.",
        "criteria": {f"opt-{i}": f"Option {i}" for i in range(n)},
    }


def issue_locations(data: object) -> list[str]:
    with pytest.raises(AppError) as info:
        parse_recipe(data)
    assert info.value.code is ErrorCode.INVALID_RECIPE
    return [i.location for i in info.value.issues]


def test_plan_example_is_valid_with_every_primitive() -> None:
    r = parse_recipe(EMAIL_TRIAGE)
    assert r.model_profile is ModelProfile.TYPED_DECISIONS
    assert [q.type for q in r.questions.values()] == ["choice", "noul", "score"]
    assert list(r.questions["department"].criteria) == ["sales", "finance", "support", "other"]  # type: ignore[union-attr]


def test_defaults() -> None:
    data = recipe()
    for key in ("description", "model_profile", "review_policy"):
        del data[key]
    r = parse_recipe(data)
    assert r.model_profile is ModelProfile.TYPED_DECISIONS
    assert r.review_policy.default_min_confidence == 0.80
    assert r.description == ""


def test_min_confidence_override() -> None:
    data = recipe()
    data["questions"]["urgent"]["min_confidence"] = 0.95
    r = parse_recipe(data)
    assert r.min_confidence("urgent") == 0.95
    assert r.min_confidence("department") == 0.80


@pytest.mark.parametrize("version", [None, 0, 2, "1", True, 1.0])
def test_schema_version_errors(version: object) -> None:
    data = recipe()
    if version is None:
        del data["schema_version"]
    else:
        data["schema_version"] = version
    assert issue_locations(data)


@pytest.mark.parametrize(
    "bad_id",
    [
        "Email-Triage",
        "email_triage",
        "../escape",
        "a/b",
        "a\\b",
        "-lead",
        "trail-",
        "double--dash",
        "",
        "x" * 65,
        "c:",
        ".",
    ],
)
def test_invalid_recipe_ids(bad_id: str) -> None:
    assert "id" in issue_locations(recipe(id=bad_id))


@pytest.mark.parametrize("bad_qid", ["Upper", "1st", "has-dash", "a/b", "", "q" * 65])
def test_invalid_question_ids(bad_qid: str) -> None:
    assert issue_locations(with_question(bad_qid, {"type": "noul", "instructions": "x"}))


def test_unknown_top_level_field_rejected() -> None:
    assert "shcema" in issue_locations(recipe(shcema=1))


def test_unknown_question_field_rejected() -> None:
    q = {"type": "noul", "instructions": "x", "instruction": "typo"}
    assert any("instruction" in loc for loc in issue_locations(with_question("q", q)))


def test_noul_rejects_criteria() -> None:
    q = {"type": "noul", "instructions": "x", "criteria": {"true": "yes"}}
    assert issue_locations(with_question("q", q))


def test_unknown_question_type_rejected() -> None:
    assert issue_locations(with_question("q", {"type": "rank", "instructions": "x"}))


def test_unknown_policy_action_rejected() -> None:
    assert issue_locations(recipe(review_policy={"on_low_confidence": "auto_approve"}))


@pytest.mark.parametrize("threshold", [-0.1, 1.5, "0.8"])
def test_threshold_bounds(threshold: object) -> None:
    assert issue_locations(recipe(review_policy={"default_min_confidence": threshold}))


def test_integer_threshold_is_accepted() -> None:
    assert parse_recipe(recipe(review_policy={"default_min_confidence": 1})).review_policy


def test_unknown_profile_rejected() -> None:
    assert "model_profile" in issue_locations(recipe(model_profile="gpt"))


@pytest.mark.parametrize("n", [0, 1, 51])
def test_choice_option_count_rejected(n: int) -> None:
    assert issue_locations(with_question("q", choice(n)))


@pytest.mark.parametrize("n", [2, 20])
def test_choice_option_count_normal(n: int) -> None:
    r = parse_recipe(with_question("q", choice(n)))
    assert not [w for w in recipe_warnings(r) if w.code is WarningCode.MANY_OPTIONS]


@pytest.mark.parametrize("n", [21, 50])
def test_choice_option_count_warned(n: int) -> None:
    r = parse_recipe(with_question("q", choice(n)))
    warned = [w for w in recipe_warnings(r) if w.code is WarningCode.MANY_OPTIONS]
    assert len(warned) == 1 and warned[0].question_id == "q"


@pytest.mark.parametrize("key", ["Upper", "has space", "a/b", "", "-x"])
def test_choice_option_keys_are_machine_keys(key: str) -> None:
    q = {"type": "choice", "instructions": "x", "criteria": {key: "a", "ok": "b"}}
    assert issue_locations(with_question("q", q))


def test_choice_criteria_must_be_mapping_with_descriptions() -> None:
    assert issue_locations(with_question("q", {**choice(2), "criteria": ["a", "b"]}))
    assert issue_locations(with_question("q", {**choice(2), "criteria": {"a": "", "b": "x"}}))
    assert issue_locations(with_question("q", {**choice(2), "criteria": {"a": 1, "b": "x"}}))


@pytest.mark.parametrize(
    "levels", [[], ["only"], ["a", "a"], [f"l{i}" for i in range(11)], {"low": "x"}]
)
def test_score_levels_rejected(levels: object) -> None:
    q = {"type": "score", "instructions": "x", "criteria": levels}
    assert issue_locations(with_question("q", q))


def test_score_always_warns() -> None:
    codes = {w.code for w in recipe_warnings(parse_recipe(EMAIL_TRIAGE))}
    assert WarningCode.SCORE_WEAK in codes


@pytest.mark.parametrize(
    ("profile", "code"),
    [
        ("multilingual", WarningCode.UNCALIBRATED_CONFIDENCE),
        ("auto", WarningCode.EXPERIMENTAL_ROUTING),
    ],
)
def test_advanced_profiles_warn(profile: str, code: WarningCode) -> None:
    codes = {w.code for w in recipe_warnings(parse_recipe(recipe(model_profile=profile)))}
    assert code in codes


def test_bounded_lengths() -> None:
    assert issue_locations(recipe(name="n" * 101))
    assert issue_locations(recipe(name=""))
    assert issue_locations(recipe(description="d" * 501))
    assert issue_locations(with_question("q", {"type": "noul", "instructions": "i" * 1001}))
    assert issue_locations(with_question("q", {"type": "noul", "instructions": ""}))
    long_option = {"type": "choice", "instructions": "x", "criteria": {"a": "c" * 301, "b": "y"}}
    assert issue_locations(with_question("q", long_option))


def test_question_count_bounds() -> None:
    assert issue_locations(recipe(questions={}))
    many = {f"q{i}": {"type": "noul", "instructions": "x"} for i in range(21)}
    assert issue_locations(recipe(questions=many))


@pytest.mark.parametrize(
    "text",
    [
        "See https://example.com/policy",
        "file:///etc/passwd",
        "Hello {{ user }}",
        "{% include x %}",
        "Use ${HOME}",
        "Path %APPDATA% here",
        "bell\x07char",
        "<% code %>",
    ],
)
def test_recipe_text_is_inert(text: str) -> None:
    assert issue_locations(recipe(description=text))
    assert issue_locations(with_question("q", {"type": "noul", "instructions": text}))
    q = {"type": "choice", "instructions": "x", "criteria": {"a": text, "b": "y"}}
    assert issue_locations(with_question("q", q))
    s = {"type": "score", "instructions": "x", "criteria": ["low", text]}
    assert issue_locations(with_question("q", s))


def test_ordinary_punctuation_is_allowed() -> None:
    text = "Refunds over $500, 50% discounts, or {urgent} tags: route to finance."
    assert parse_recipe(recipe(description=text)).description == text


def test_not_a_mapping() -> None:
    assert issue_locations(["not", "a", "recipe"]) == ["recipe"]


def test_issue_messages_do_not_echo_input() -> None:
    secret = "sk-this-should-never-echo"  # secret-scan: allow
    data = recipe(id=secret.upper())
    with pytest.raises(AppError) as info:
        parse_recipe(data)
    assert all(secret.upper() not in i.message for i in info.value.issues)


def test_validate_recipe_report() -> None:
    ok = validate_recipe(EMAIL_TRIAGE)
    assert ok.valid and ok.recipe is not None and ok.warnings
    bad = validate_recipe(recipe(id="Bad"))
    assert not bad.valid and bad.issues and bad.recipe is None


def test_recipes_are_immutable() -> None:
    r = parse_recipe(EMAIL_TRIAGE)
    with pytest.raises(Exception):  # noqa: B017 - pydantic raises ValidationError
        r.name = "changed"  # type: ignore[misc]


def test_round_trip_is_lossless() -> None:
    r = parse_recipe(EMAIL_TRIAGE)
    again = Recipe.model_validate_json(r.model_dump_json())
    assert again == r
    assert r.model_dump(mode="json", exclude_none=True) == EMAIL_TRIAGE
