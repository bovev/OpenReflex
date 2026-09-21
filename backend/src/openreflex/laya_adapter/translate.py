"""Product recipe -> Laya question schema (laya 0.3.4)."""

from __future__ import annotations

from typing import Any

from openreflex.domain.recipe import ChoiceQuestion, Recipe, ScoreQuestion


def to_laya_questions(recipe: Recipe) -> dict[str, dict[str, Any]]:
    questions: dict[str, dict[str, Any]] = {}
    for qid, q in recipe.questions.items():
        item: dict[str, Any] = {"type": q.type, "instructions": q.instructions}
        if isinstance(q, ChoiceQuestion):
            item["criteria"] = dict(q.criteria)
        elif isinstance(q, ScoreQuestion):
            item["criteria"] = list(q.criteria)
        questions[qid] = item
    return questions
