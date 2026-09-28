"""Product-owned decision recipe schema (``schema_version: 1``).

This is the public contract. It deliberately doesn't mirror Laya's Python
dictionaries. The adapter translates between the two.
"""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Annotated, Any, Final, Literal, cast

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from openreflex.identity import RECIPE_SCHEMA_VERSION

RECIPE_ID_PATTERN: Final = r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
QUESTION_ID_PATTERN: Final = r"^[a-z][a-z0-9_]*$"
OPTION_KEY_PATTERN: Final = r"^[a-z0-9]+(?:[_-][a-z0-9]+)*$"

MAX_ID_LENGTH: Final = 64
MAX_NAME_LENGTH: Final = 100
MAX_DESCRIPTION_LENGTH: Final = 500
MAX_INSTRUCTIONS_LENGTH: Final = 1000
MAX_CRITERION_LENGTH: Final = 300
MAX_QUESTIONS: Final = 20

CHOICE_MIN_OPTIONS: Final = 2
CHOICE_RECOMMENDED_MAX_OPTIONS: Final = 20
CHOICE_MAX_OPTIONS: Final = 50
SCORE_MIN_LEVELS: Final = 2
SCORE_MAX_LEVELS: Final = 10

# Recipes are inert data. Nothing in them is ever expanded, templated,
# fetched, or opened, and text that looks like it might be is rejected so
# authors are not misled into thinking it would be.
_FORBIDDEN_TEXT: Final = (
    (re.compile(r"\{\{|\{%|\$\{|<%"), "template or expansion syntax is not allowed"),
    (re.compile(r"%[A-Za-z_][A-Za-z0-9_]*%"), "environment-variable syntax is not allowed"),
    (re.compile(r"[a-z][a-z0-9+.-]*://", re.IGNORECASE), "URLs are not allowed"),
    (re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]"), "control characters are not allowed"),
)


def check_inert_text(value: str) -> str:
    for pattern, message in _FORBIDDEN_TEXT:
        if pattern.search(value):
            raise ValueError(message)
    return value


Name = Annotated[str, StringConstraints(min_length=1, max_length=MAX_NAME_LENGTH)]
Description = Annotated[str, StringConstraints(max_length=MAX_DESCRIPTION_LENGTH)]
Instructions = Annotated[str, StringConstraints(min_length=1, max_length=MAX_INSTRUCTIONS_LENGTH)]
Criterion = Annotated[str, StringConstraints(min_length=1, max_length=MAX_CRITERION_LENGTH)]
RecipeId = Annotated[
    str, StringConstraints(min_length=1, max_length=MAX_ID_LENGTH, pattern=RECIPE_ID_PATTERN)
]
QuestionId = Annotated[
    str, StringConstraints(min_length=1, max_length=MAX_ID_LENGTH, pattern=QUESTION_ID_PATTERN)
]
OptionKey = Annotated[
    str, StringConstraints(min_length=1, max_length=MAX_ID_LENGTH, pattern=OPTION_KEY_PATTERN)
]
Threshold = Annotated[float, Field(ge=0.0, le=1.0, strict=True)]


class ModelProfile(StrEnum):
    TYPED_DECISIONS = "typed-decisions"
    ENGLISH = "english"
    MULTILINGUAL = "multilingual"
    AUTO = "auto"


DEFAULT_PROFILE: Final = ModelProfile.TYPED_DECISIONS


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class _QuestionBase(_Strict):
    instructions: Instructions
    min_confidence: Threshold | None = Field(
        default=None, description="Overrides the recipe's default review threshold."
    )

    @field_validator("instructions")
    @classmethod
    def _inert_instructions(cls, value: str) -> str:
        return check_inert_text(value)


class ChoiceQuestion(_QuestionBase):
    type: Literal["choice"]
    criteria: dict[OptionKey, Criterion] = Field(
        description="Stable machine keys mapped to clear descriptions, in display order."
    )

    @field_validator("criteria")
    @classmethod
    def _check_options(cls, value: dict[str, str]) -> dict[str, str]:
        if len(value) < CHOICE_MIN_OPTIONS:
            raise ValueError(f"a choice question needs at least {CHOICE_MIN_OPTIONS} options")
        if len(value) > CHOICE_MAX_OPTIONS:
            raise ValueError(f"a choice question allows at most {CHOICE_MAX_OPTIONS} options")
        for text in value.values():
            check_inert_text(text)
        return value


class ScoreQuestion(_QuestionBase):
    type: Literal["score"]
    criteria: list[Criterion] = Field(description="Ordered levels, lowest first.")

    @field_validator("criteria")
    @classmethod
    def _check_levels(cls, value: list[str]) -> list[str]:
        if len(value) < SCORE_MIN_LEVELS:
            raise ValueError(f"a score question needs at least {SCORE_MIN_LEVELS} levels")
        if len(value) > SCORE_MAX_LEVELS:
            raise ValueError(f"a score question allows at most {SCORE_MAX_LEVELS} levels")
        if len(set(value)) != len(value):
            raise ValueError("score levels must be distinct")
        for text in value:
            check_inert_text(text)
        return value


class NoulQuestion(_QuestionBase):
    """A probability-like true/false judgement. Takes no criteria."""

    type: Literal["noul"]


Question = Annotated[ChoiceQuestion | ScoreQuestion | NoulQuestion, Field(discriminator="type")]


class LowConfidenceAction(StrEnum):
    NEEDS_REVIEW = "needs_review"


class ReviewPolicy(_Strict):
    default_min_confidence: Threshold = 0.80
    on_low_confidence: LowConfidenceAction = LowConfidenceAction.NEEDS_REVIEW


class Recipe(_Strict):
    schema_version: int = Field(strict=True, description="Must be 1.")
    id: RecipeId
    name: Name
    description: Description = ""
    model_profile: ModelProfile = DEFAULT_PROFILE
    questions: dict[QuestionId, Question]
    review_policy: ReviewPolicy = ReviewPolicy()

    @field_validator("schema_version")
    @classmethod
    def _check_schema_version(cls, value: int) -> int:
        if value != RECIPE_SCHEMA_VERSION:
            raise ValueError(
                f"unsupported schema_version {value}; expected {RECIPE_SCHEMA_VERSION}"
            )
        return value

    @field_validator("name", "description")
    @classmethod
    def _inert_names(cls, value: str) -> str:
        return check_inert_text(value)

    @field_validator("questions")
    @classmethod
    def _check_questions(cls, value: dict[str, Any]) -> dict[str, Any]:
        if not value:
            raise ValueError("a recipe needs at least one question")
        if len(value) > MAX_QUESTIONS:
            raise ValueError(f"a recipe allows at most {MAX_QUESTIONS} questions")
        return value

    @model_validator(mode="before")
    @classmethod
    def _require_schema_version(cls, data: object) -> object:
        if isinstance(data, dict) and "schema_version" not in cast(dict[object, object], data):
            raise ValueError("schema_version is required")
        return cast(object, data)

    def min_confidence(self, question_id: str) -> float:
        override = self.questions[question_id].min_confidence
        return self.review_policy.default_min_confidence if override is None else override
