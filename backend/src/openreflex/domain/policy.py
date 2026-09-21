"""Turn raw engine output into the public result, applying the review policy.

``review`` is a routing signal for people, not a claim that an answer is
right. An answer needs review when its confidence is below the question's
threshold. The whole decision needs review when any answer does, or when
the engine couldn't see all of the input or recipe (truncation).
"""

from __future__ import annotations

from typing import Final

from openreflex.domain.decision import (
    Answer,
    ChoiceAnswer,
    DecisionResult,
    DecisionWarning,
    NoulAnswer,
    Review,
    ScoreAnswer,
    WarningCode,
)
from openreflex.domain.engine import ChoiceOutput, EngineResult, NoulOutput, ScoreOutput
from openreflex.domain.errors import AppError, ErrorCode
from openreflex.domain.recipe import ChoiceQuestion, NoulQuestion, Recipe, ScoreQuestion
from openreflex.domain.validation import recipe_warnings

REVIEW_FORCING: Final = frozenset(
    {
        WarningCode.INPUT_TRUNCATED,
        WarningCode.INSTRUCTIONS_TRUNCATED,
        WarningCode.OPTIONS_TRUNCATED,
    }
)


def _incompatible(message: str) -> AppError:
    return AppError(
        ErrorCode.ENGINE_INCOMPATIBLE, f"engine output does not match recipe: {message}"
    )


def _review(confidence: float, threshold: float) -> Review:
    return Review.OK if confidence >= threshold else Review.NEEDS_REVIEW


def _choice(q: ChoiceQuestion, out: ChoiceOutput, threshold: float) -> ChoiceAnswer:
    keys = list(q.criteria)
    if set(out.probabilities) != set(keys):
        raise _incompatible("choice options differ")
    # Ties resolve to the earliest option in recipe order.
    best = max(keys, key=lambda k: (out.probabilities[k], -keys.index(k)))
    return ChoiceAnswer(
        choice=best,
        probability=out.probabilities[best],
        confidence=out.confidence,
        probabilities={k: out.probabilities[k] for k in keys},
        review=_review(out.confidence, threshold),
    )


def _score(q: ScoreQuestion, out: ScoreOutput, threshold: float) -> ScoreAnswer:
    levels = q.criteria
    if len(out.probabilities) != len(levels):
        raise _incompatible("score level count differs")
    level = max(range(len(levels)), key=lambda i: (out.probabilities[i], -i))
    return ScoreAnswer(
        score=min(out.expected, float(len(levels) - 1)),
        level=level,
        label=levels[level],
        probability=out.probabilities[level],
        confidence=out.confidence,
        probabilities=list(out.probabilities),
        review=_review(out.confidence, threshold),
    )


def _noul(out: NoulOutput, threshold: float) -> NoulAnswer:
    return NoulAnswer(
        value=out.probability_true >= 0.5,
        probability_true=out.probability_true,
        confidence=out.confidence,
        review=_review(out.confidence, threshold),
    )


def build_answers(recipe: Recipe, result: EngineResult) -> dict[str, Answer]:
    if set(result.outputs) != set(recipe.questions):
        raise _incompatible("question ids differ")
    answers: dict[str, Answer] = {}
    for qid, question in recipe.questions.items():
        out = result.outputs[qid]
        threshold = recipe.min_confidence(qid)
        if isinstance(question, ChoiceQuestion) and isinstance(out, ChoiceOutput):
            answers[qid] = _choice(question, out, threshold)
        elif isinstance(question, ScoreQuestion) and isinstance(out, ScoreOutput):
            answers[qid] = _score(question, out, threshold)
        elif isinstance(question, NoulQuestion) and isinstance(out, NoulOutput):
            answers[qid] = _noul(out, threshold)
        else:
            raise _incompatible(f"question {qid!r} has the wrong answer type")
    return answers


def evaluate(
    recipe: Recipe, result: EngineResult, *, request_id: str, timing_ms: float
) -> DecisionResult:
    answers = build_answers(recipe, result)
    warnings: list[DecisionWarning] = [*recipe_warnings(recipe), *result.warnings]
    for qid, answer in answers.items():
        if answer.review is Review.NEEDS_REVIEW:
            warnings.append(
                DecisionWarning(
                    code=WarningCode.LOW_CONFIDENCE,
                    question_id=qid,
                    message=f"Confidence {answer.confidence:.2f} is below this question's "
                    f"review threshold of {recipe.min_confidence(qid):.2f}.",
                )
            )
    unique: dict[tuple[WarningCode, str | None], DecisionWarning] = {}
    for w in warnings:
        unique.setdefault((w.code, w.question_id), w)
    warnings = list(unique.values())

    needs_review = any(a.review is Review.NEEDS_REVIEW for a in answers.values()) or any(
        w.code in REVIEW_FORCING for w in warnings
    )
    return DecisionResult(
        request_id=request_id,
        recipe_id=recipe.id,
        review=Review.NEEDS_REVIEW if needs_review else Review.OK,
        model=result.model,
        answers=answers,
        warnings=warnings,
        timing_ms=round(timing_ms, 1),
    )
