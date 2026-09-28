"""The boundary every decision engine implements.

Engines return raw per-question distributions plus engine-level warnings.
They never decide review status: that's the policy's job (see
``openreflex.domain.policy``), so every engine gets identical review behaviour.
"""

from __future__ import annotations

from typing import Annotated, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from openreflex.domain.decision import DecisionWarning, ModelInfo
from openreflex.domain.recipe import ModelProfile, Recipe

Probability = Annotated[float, Field(ge=0.0, le=1.0)]
_SUM_TOLERANCE = 0.02


class _Output(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _check_distribution(values: list[float]) -> None:
    if abs(sum(values) - 1.0) > _SUM_TOLERANCE:
        raise ValueError("probabilities must sum to 1")


class ChoiceOutput(_Output):
    type: Literal["choice"] = "choice"
    probabilities: dict[str, Probability]
    confidence: Probability

    @model_validator(mode="after")
    def _sums(self) -> ChoiceOutput:
        _check_distribution(list(self.probabilities.values()))
        return self


class ScoreOutput(_Output):
    type: Literal["score"] = "score"
    probabilities: list[Probability]
    expected: Annotated[float, Field(ge=0.0)]
    confidence: Probability

    @model_validator(mode="after")
    def _sums(self) -> ScoreOutput:
        _check_distribution(self.probabilities)
        return self


class NoulOutput(_Output):
    type: Literal["noul"] = "noul"
    probability_true: Probability
    confidence: Probability


QuestionOutput = Annotated[ChoiceOutput | ScoreOutput | NoulOutput, Field(discriminator="type")]


class EngineResult(_Output):
    model: ModelInfo
    outputs: dict[str, QuestionOutput]
    warnings: list[DecisionWarning] = []


class EngineStatus(_Output):
    engine: str
    loaded_profile: ModelProfile | None = None
    loaded_checkpoint: str | None = None


class DecisionEngine(Protocol):
    """Synchronous engine API. Callers run it off the event loop."""

    def ensure_model(self, profile: ModelProfile) -> ModelInfo:
        """Load (or reuse) the model for ``profile``. Raises AppError(MODEL_NOT_READY)."""
        ...

    def predict(self, state: dict[str, JsonValue], recipe: Recipe) -> EngineResult:
        """Evaluate every question of ``recipe`` against ``state``."""
        ...

    def unload(self) -> None: ...

    def status(self) -> EngineStatus: ...
