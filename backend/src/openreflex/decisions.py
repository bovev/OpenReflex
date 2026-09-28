"""Run one recipe against one input: the use case behind REST and MCP."""

from __future__ import annotations

import time
import uuid

from openreflex.domain.decision import (
    DecisionResult,
    InputLimitError,
    InputTooLargeError,
    normalize_input,
)
from openreflex.domain.engine import DecisionEngine
from openreflex.domain.errors import AppError, ErrorCode
from openreflex.domain.policy import evaluate
from openreflex.recipes.store import RecipeStore


class DecisionService:
    def __init__(self, store: RecipeStore, engine: DecisionEngine) -> None:
        self._store = store
        self._engine = engine

    @property
    def engine(self) -> DecisionEngine:
        return self._engine

    def run(
        self, recipe_id: str, raw_input: object, request_id: str | None = None
    ) -> DecisionResult:
        """Blocking. Callers on an event loop must run this in a worker thread."""
        recipe = self._store.get(recipe_id)
        try:
            state = normalize_input(raw_input)
        except InputLimitError as exc:
            too_large = isinstance(exc, InputTooLargeError)
            code = ErrorCode.INPUT_TOO_LARGE if too_large else ErrorCode.INVALID_INPUT
            raise AppError(code, str(exc)) from exc
        started = time.perf_counter()
        try:
            self._engine.ensure_model(recipe.model_profile)
            result = self._engine.predict(state, recipe)
        except AppError:
            raise
        except Exception as exc:
            # Upstream messages can contain input fragments; never pass them on.
            raise AppError(
                ErrorCode.ENGINE_FAILURE, "the engine failed to produce a decision"
            ) from exc
        elapsed_ms = (time.perf_counter() - started) * 1000
        return evaluate(
            recipe, result, request_id=request_id or str(uuid.uuid4()), timing_ms=elapsed_ms
        )
