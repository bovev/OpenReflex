"""Recipe validation with actionable issues and non-fatal warnings."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, ValidationError

from openreflex.domain.decision import DecisionWarning, WarningCode
from openreflex.domain.errors import AppError, ErrorCode, Issue
from openreflex.domain.recipe import (
    CHOICE_RECOMMENDED_MAX_OPTIONS,
    ChoiceQuestion,
    ModelProfile,
    Recipe,
    ScoreQuestion,
)


class ValidationReport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    valid: bool
    issues: list[Issue] = []
    warnings: list[DecisionWarning] = []
    recipe: Recipe | None = None


def issues_from(exc: ValidationError) -> list[Issue]:
    # Only location and message: pydantic's `input` field could echo content.
    issues: list[Issue] = []
    for err in exc.errors(include_url=False, include_input=False, include_context=False):
        location = ".".join(str(part) for part in err["loc"]) or "recipe"
        issues.append(Issue(location=location, message=err["msg"]))
    return issues


def parse_recipe(data: object) -> Recipe:
    """Validate raw data into a recipe or raise ``AppError(INVALID_RECIPE)``."""
    try:
        return Recipe.model_validate(data)
    except ValidationError as exc:
        raise AppError(ErrorCode.INVALID_RECIPE, "recipe is invalid", issues_from(exc)) from exc


def recipe_warnings(recipe: Recipe) -> list[DecisionWarning]:
    """Warnings that apply to every run of ``recipe``, independent of input."""
    warnings: list[DecisionWarning] = []
    if recipe.model_profile is ModelProfile.MULTILINGUAL:
        warnings.append(
            DecisionWarning(
                code=WarningCode.UNCALIBRATED_CONFIDENCE,
                message="The multilingual model's confidence is less well calibrated; "
                "review results before relying on them.",
            )
        )
    elif recipe.model_profile is ModelProfile.AUTO:
        warnings.append(
            DecisionWarning(
                code=WarningCode.EXPERIMENTAL_ROUTING,
                message="Automatic model routing is experimental; the model used is "
                "reported with each result.",
            )
        )
    for qid, question in recipe.questions.items():
        if isinstance(question, ChoiceQuestion):
            n = len(question.criteria)
            if n > CHOICE_RECOMMENDED_MAX_OPTIONS:
                warnings.append(
                    DecisionWarning(
                        code=WarningCode.MANY_OPTIONS,
                        question_id=qid,
                        message=f"{n} options is above the recommended "
                        f"{CHOICE_RECOMMENDED_MAX_OPTIONS}; accuracy can drop sharply.",
                    )
                )
        elif isinstance(question, ScoreQuestion):
            warnings.append(
                DecisionWarning(
                    code=WarningCode.SCORE_WEAK,
                    question_id=qid,
                    message="Ordinal score questions are currently less reliable than "
                    "choice and true/false questions.",
                )
            )
    return warnings


def validate_recipe(data: object) -> ValidationReport:
    try:
        recipe = parse_recipe(data)
    except AppError as exc:
        return ValidationReport(valid=False, issues=exc.issues)
    return ValidationReport(valid=True, warnings=recipe_warnings(recipe), recipe=recipe)
