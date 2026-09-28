"""How engines find installed, verified model files."""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

from pydantic import BaseModel, ConfigDict

from openreflex.domain.recipe import ModelProfile
from openreflex.models.catalog import Checkpoint


class InstalledModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, arbitrary_types_allowed=True)

    checkpoint: Checkpoint
    path: Path  # the checkpoint directory (contains rl_agent_config.json)


class ModelLocator(Protocol):
    def locate(self, profile: ModelProfile) -> InstalledModel:
        """Return the verified local copy, or raise AppError(MODEL_NOT_READY)."""
        ...
