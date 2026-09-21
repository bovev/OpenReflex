"""Decision input and the product-owned result envelope (``contract_version: 1``)."""

from __future__ import annotations

import json
import math
from enum import StrEnum
from typing import Annotated, Any, Final, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, JsonValue, TypeAdapter, ValidationError

from openreflex.domain.recipe import ModelProfile, OptionKey, QuestionId, RecipeId
from openreflex.identity import RESULT_CONTRACT_VERSION

MAX_INPUT_BYTES: Final = 128 * 1024
MAX_INPUT_DEPTH: Final = 8
MAX_INPUT_FIELDS: Final = 500


class InputLimitError(ValueError):
    """Decision input is outside the V1 bounds."""


def _measure(value: object, depth: int, counter: list[int]) -> None:
    if depth > MAX_INPUT_DEPTH:
        raise InputLimitError(f"input nesting exceeds {MAX_INPUT_DEPTH} levels")
    children: list[object]
    if isinstance(value, dict):
        children = list(cast(dict[object, object], value).values())
    elif isinstance(value, list):
        children = cast(list[object], value)
    else:
        if isinstance(value, float) and not math.isfinite(value):
            raise InputLimitError("input numbers must be finite")
        return
    counter[0] += len(children)
    if counter[0] > MAX_INPUT_FIELDS:
        raise InputLimitError(f"input has more than {MAX_INPUT_FIELDS} fields")
    for child in children:
        _measure(child, depth + 1, counter)


_STATE: Final = TypeAdapter(dict[str, JsonValue])


def normalize_input(value: object) -> dict[str, JsonValue]:
    """Turn caller input into the state object handed to an engine.

    Plain text becomes ``{"text": ...}``. A JSON object passes through after
    bounds checks. Nothing is ever interpreted as a path, URL, or attachment.
    """
    if isinstance(value, str):
        if not value.strip():
            raise InputLimitError("input is empty")
        state: dict[str, JsonValue] = {"text": value}
    elif isinstance(value, dict):
        if not value:
            raise InputLimitError("input is empty")
        _measure(cast(object, value), 1, [0])
        try:
            state = _STATE.validate_python(value, strict=True)
        except ValidationError as exc:
            raise InputLimitError("input must be a JSON object") from exc
    else:
        raise InputLimitError("input must be text or a JSON object")
    try:
        encoded = json.dumps(state, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except ValueError as exc:
        raise InputLimitError("input numbers must be finite") from exc
    if len(encoded) > MAX_INPUT_BYTES:
        raise InputLimitError(f"input exceeds {MAX_INPUT_BYTES} bytes when serialized")
    return state


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


Probability = Annotated[float, Field(ge=0.0, le=1.0)]


class Review(StrEnum):
    OK = "ok"
    NEEDS_REVIEW = "needs_review"


class Status(StrEnum):
    COMPLETED = "completed"


class WarningCode(StrEnum):
    INPUT_TRUNCATED = "input_truncated"
    INSTRUCTIONS_TRUNCATED = "instructions_truncated"
    OPTIONS_TRUNCATED = "options_truncated"
    MANY_OPTIONS = "many_options"
    SCORE_WEAK = "score_weak"
    LOW_CONFIDENCE = "low_confidence"
    UNCALIBRATED_CONFIDENCE = "uncalibrated_confidence"
    EXPERIMENTAL_ROUTING = "experimental_routing"


class DecisionWarning(_Contract):
    code: WarningCode
    message: str
    question_id: QuestionId | None = None


class ChoiceAnswer(_Contract):
    type: Literal["choice"] = "choice"
    choice: OptionKey
    probability: Probability = Field(description="Probability of the chosen option.")
    confidence: Probability = Field(description="Engine confidence the review policy uses.")
    probabilities: dict[OptionKey, Probability]
    review: Review


class ScoreAnswer(_Contract):
    type: Literal["score"] = "score"
    score: Annotated[float, Field(ge=0.0)] = Field(description="Expected level (0 = lowest).")
    level: Annotated[int, Field(ge=0)] = Field(description="Most likely level index.")
    label: str = Field(description="Criteria text of `level`.")
    probability: Probability = Field(description="Probability of `level`.")
    confidence: Probability
    probabilities: list[Probability] = Field(description="Per level, lowest first.")
    review: Review


class NoulAnswer(_Contract):
    type: Literal["noul"] = "noul"
    value: bool = Field(description="True when probability_true >= 0.5.")
    probability_true: Probability
    confidence: Probability
    review: Review


Answer = Annotated[ChoiceAnswer | ScoreAnswer | NoulAnswer, Field(discriminator="type")]


class Device(StrEnum):
    CPU = "cpu"
    CUDA = "cuda"
    MPS = "mps"
    FAKE = "fake"


class ModelInfo(_Contract):
    profile: ModelProfile = Field(description="Profile the recipe asked for.")
    resolved_profile: ModelProfile = Field(description="Profile that ran (differs for `auto`).")
    checkpoint: str
    revision: str
    device: Device


class DecisionResult(_Contract):
    request_id: str
    recipe_id: RecipeId
    status: Status = Status.COMPLETED
    review: Review = Field(
        description="Derived from the review policy and warnings. Not a claim of correctness."
    )
    model: ModelInfo
    answers: dict[QuestionId, Answer]
    warnings: list[DecisionWarning]
    timing_ms: Annotated[float, Field(ge=0.0)]
    contract_version: Literal[1] = RESULT_CONTRACT_VERSION


class DecisionRequest(_Contract):
    """What an API or MCP caller sends: a recipe id and text or a JSON object."""

    recipe_id: RecipeId
    input: str | dict[str, JsonValue]


def json_schema(model: type[BaseModel]) -> dict[str, Any]:
    return model.model_json_schema(mode="serialization")
