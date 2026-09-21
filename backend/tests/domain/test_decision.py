from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from openreflex.domain.decision import (
    MAX_INPUT_BYTES,
    MAX_INPUT_DEPTH,
    MAX_INPUT_FIELDS,
    DecisionRequest,
    DecisionResult,
    InputLimitError,
    normalize_input,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "contracts"


def test_text_becomes_text_object() -> None:
    assert normalize_input("hello") == {"text": "hello"}


def test_json_object_passes_through() -> None:
    state = {"subject": "Refund", "amount": 12.5, "tags": ["a", "b"], "meta": {"x": None}}
    assert normalize_input(state) == state


@pytest.mark.parametrize("value", ["", "   ", {}, None, 3, ["list"], b"bytes", 1.5])
def test_rejects_empty_or_non_object(value: object) -> None:
    with pytest.raises(InputLimitError):
        normalize_input(value)


def test_rejects_non_json_values() -> None:
    with pytest.raises(InputLimitError):
        normalize_input({"when": object()})
    with pytest.raises(InputLimitError):
        normalize_input({1: "int key"})
    with pytest.raises(InputLimitError):
        normalize_input({"n": float("nan")})
    with pytest.raises(InputLimitError):
        normalize_input({"n": float("inf")})


def test_depth_limit() -> None:
    ok: dict[str, Any] = {}
    node = ok
    for _ in range(MAX_INPUT_DEPTH - 1):
        node["n"] = {}
        node = node["n"]
    assert normalize_input(ok)
    node["n"] = {"too": "deep"}
    with pytest.raises(InputLimitError, match="nesting"):
        normalize_input(ok)


def test_field_limit() -> None:
    assert normalize_input({f"k{i}": i for i in range(MAX_INPUT_FIELDS)})
    with pytest.raises(InputLimitError, match="fields"):
        normalize_input({f"k{i}": i for i in range(MAX_INPUT_FIELDS + 1)})
    with pytest.raises(InputLimitError, match="fields"):
        normalize_input({"list": list(range(MAX_INPUT_FIELDS))})


def test_size_limit_counts_serialized_utf8() -> None:
    assert normalize_input("a" * (MAX_INPUT_BYTES - 20))
    with pytest.raises(InputLimitError, match="bytes"):
        normalize_input("a" * MAX_INPUT_BYTES)
    with pytest.raises(InputLimitError, match="bytes"):
        normalize_input("ä" * (MAX_INPUT_BYTES // 2))


def test_deeply_nested_hostile_input_fails_fast() -> None:
    hostile: list[Any] = []
    node = hostile
    for _ in range(10_000):
        child: list[Any] = []
        node.append(child)
        node = child
    with pytest.raises(InputLimitError):
        normalize_input({"x": hostile})


def test_path_or_url_text_is_only_ever_text() -> None:
    assert normalize_input("C:\\Windows\\win.ini") == {"text": "C:\\Windows\\win.ini"}
    assert normalize_input("https://example.com") == {"text": "https://example.com"}


def test_request_rejects_extra_source_fields() -> None:
    with pytest.raises(ValidationError):
        DecisionRequest.model_validate({"recipe_id": "a", "input": "x", "path": "C:/x"})
    with pytest.raises(ValidationError):
        DecisionRequest.model_validate({"recipe_id": "a", "url": "https://x"})


def test_result_fixture_round_trips() -> None:
    raw = json.loads((FIXTURES / "decision-result.json").read_text(encoding="utf-8"))
    result = DecisionResult.model_validate(raw)
    assert result.model_dump(mode="json") == raw
    assert result.contract_version == 1


def test_result_rejects_unknown_fields_and_bad_probabilities() -> None:
    raw = json.loads((FIXTURES / "decision-result.json").read_text(encoding="utf-8"))
    with pytest.raises(ValidationError):
        DecisionResult.model_validate({**raw, "extra": 1})
    raw["answers"]["urgent"]["probability_true"] = 1.2
    with pytest.raises(ValidationError):
        DecisionResult.model_validate(raw)
