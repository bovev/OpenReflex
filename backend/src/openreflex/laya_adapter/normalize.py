"""Laya response -> product engine outputs, with strict field checks.

Required fields missing or of the wrong type raise ENGINE_INCOMPATIBLE rather
than producing a corrupt result. Unknown or optional fields (``action``,
``legend``, ``usage``) are ignored.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any, cast

from pydantic import ValidationError

from openreflex.domain.engine import ChoiceOutput, NoulOutput, QuestionOutput, ScoreOutput
from openreflex.domain.errors import AppError, ErrorCode
from openreflex.domain.recipe import ChoiceQuestion, Recipe, ScoreQuestion


def _incompatible(detail: str) -> AppError:
    return AppError(ErrorCode.ENGINE_INCOMPATIBLE, f"unexpected Laya output: {detail}")


def _num(value: object, where: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise _incompatible(f"{where} is not a finite number")
    return float(value)


def _map(value: object) -> Mapping[str, object] | None:
    return cast(Mapping[str, object], value) if isinstance(value, Mapping) else None


def _field(answer: Mapping[str, object], name: str, qid: str) -> object:
    if name not in answer:
        raise _incompatible(f"{qid}.{name} is missing")
    return answer[name]


def _probabilities(answer: Mapping[str, object], qid: str, keys: list[str]) -> list[float]:
    probs = _map(_field(answer, "probabilities", qid))
    if probs is None or set(probs) != set(keys):
        raise _incompatible(f"{qid}.probabilities do not match the recipe's options")
    return [_num(probs[k], f"{qid}.probabilities") for k in keys]


def normalize_answers(response: Mapping[str, Any], recipe: Recipe) -> dict[str, QuestionOutput]:
    answers = _map(response.get("answers"))
    if answers is None:
        raise _incompatible("answers is missing")
    outputs: dict[str, QuestionOutput] = {}
    try:
        for qid, question in recipe.questions.items():
            answer = _map(answers.get(qid))
            if answer is None:
                raise _incompatible(f"{qid} is missing")
            if answer.get("type") != question.type:
                raise _incompatible(f"{qid} has an unexpected type")
            confidence = _num(_field(answer, "confidence", qid), f"{qid}.confidence")
            if isinstance(question, ChoiceQuestion):
                keys = list(question.criteria)
                outputs[qid] = ChoiceOutput(
                    probabilities=dict(zip(keys, _probabilities(answer, qid, keys), strict=True)),
                    confidence=confidence,
                )
            elif isinstance(question, ScoreQuestion):
                keys = [str(i) for i in range(len(question.criteria))]
                outputs[qid] = ScoreOutput(
                    probabilities=_probabilities(answer, qid, keys),
                    expected=_num(_field(answer, "score", qid), f"{qid}.score"),
                    confidence=confidence,
                )
            else:
                outputs[qid] = NoulOutput(
                    probability_true=_num(_field(answer, "noul", qid), f"{qid}.noul"),
                    confidence=confidence,
                )
    except ValidationError as exc:
        raise _incompatible("values are out of range") from exc
    return outputs
