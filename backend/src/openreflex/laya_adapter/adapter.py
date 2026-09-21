"""``DecisionEngine`` implementation backed by the pinned Laya package."""

from __future__ import annotations

import contextlib
import gc
import sys
import threading
from typing import Any

from pydantic import JsonValue

from openreflex.domain.decision import Device, ModelInfo
from openreflex.domain.engine import EngineResult, EngineStatus
from openreflex.domain.errors import AppError, ErrorCode
from openreflex.domain.recipe import ModelProfile, Recipe
from openreflex.laya_adapter._upstream import (
    SUPPORTED_VERSION,
    Agent,
    Upstream,
    UpstreamFactory,
    import_upstream,
)
from openreflex.laya_adapter.budget import budget_warnings
from openreflex.laya_adapter.normalize import normalize_answers
from openreflex.laya_adapter.translate import to_laya_questions
from openreflex.models.catalog import AUTO_CANDIDATES
from openreflex.models.types import InstalledModel, ModelLocator

_DEVICES = {d.value: d for d in Device}


class LayaAdapter:
    """Caches one loaded checkpoint. Loading and inference are serialized."""

    def __init__(
        self,
        locator: ModelLocator,
        *,
        device: str = "cpu",
        upstream_factory: UpstreamFactory = import_upstream,
    ) -> None:
        self._locator = locator
        self._device = device
        self._factory = upstream_factory
        self._upstream: Upstream | None = None
        self._lock = threading.RLock()
        self._agent: Agent | None = None
        self._loaded: InstalledModel | None = None

    # -- upstream ------------------------------------------------------------

    def _laya(self) -> Upstream:
        if self._upstream is None:
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    upstream = self._factory()
            except ImportError as exc:
                raise AppError(
                    ErrorCode.ENGINE_INCOMPATIBLE, "the Laya runtime is not installed"
                ) from exc
            if upstream.version != SUPPORTED_VERSION:
                raise AppError(
                    ErrorCode.ENGINE_INCOMPATIBLE,
                    f"Laya {upstream.version} is installed; this version needs {SUPPORTED_VERSION}",
                )
            self._upstream = upstream
        return self._upstream

    # -- model lifecycle -----------------------------------------------------

    def _load(self, profile: ModelProfile) -> tuple[Agent, InstalledModel]:
        with self._lock:
            installed = self._locator.locate(profile)
            if self._agent is not None and self._loaded == installed:
                return self._agent, installed
            upstream = self._laya()
            self.unload()
            try:
                # Laya prints warnings to stdout, and stdout may be an MCP channel.
                with contextlib.redirect_stdout(sys.stderr):
                    agent = upstream.load(str(installed.path), self._device)
            except (FileNotFoundError, ValueError, KeyError) as exc:
                raise AppError(
                    ErrorCode.ENGINE_INCOMPATIBLE,
                    "the installed model files are not compatible with this Laya version",
                ) from exc
            except Exception as exc:
                raise AppError(ErrorCode.ENGINE_FAILURE, "the model could not be loaded") from exc
            self._agent, self._loaded = agent, installed
            return agent, installed

    def _info(self, requested: ModelProfile, installed: InstalledModel, agent: Agent) -> ModelInfo:
        device_type = str(getattr(agent.device, "type", agent.device))
        return ModelInfo(
            profile=requested,
            resolved_profile=installed.checkpoint.profile,
            checkpoint=installed.checkpoint.checkpoint_id,
            revision=installed.checkpoint.revision,
            device=_DEVICES.get(device_type, Device.CPU),
        )

    def ensure_model(self, profile: ModelProfile) -> ModelInfo:
        if profile is ModelProfile.AUTO:
            # Routing depends on the input, so check every candidate is installed
            # and warm up the first one.
            for candidate in AUTO_CANDIDATES:
                self._locator.locate(candidate)
            to_load = AUTO_CANDIDATES[0]
        else:
            to_load = profile
        agent, installed = self._load(to_load)
        return self._info(profile, installed, agent)

    def unload(self) -> None:
        with self._lock:
            if self._agent is not None:
                self._agent = None
                self._loaded = None
                gc.collect()

    def status(self) -> EngineStatus:
        loaded = self._loaded
        return EngineStatus(
            engine="laya",
            loaded_profile=loaded.checkpoint.profile if loaded else None,
            loaded_checkpoint=loaded.checkpoint.checkpoint_id if loaded else None,
        )

    # -- inference -----------------------------------------------------------

    def _route(self, state: dict[str, JsonValue], questions: dict[str, Any]) -> ModelProfile:
        routed = self._laya().route(state, questions)
        try:
            profile = ModelProfile(routed)
        except ValueError as exc:
            raise AppError(
                ErrorCode.ENGINE_INCOMPATIBLE, "Laya routed to an unknown model"
            ) from exc
        if profile not in AUTO_CANDIDATES:
            raise AppError(ErrorCode.ENGINE_INCOMPATIBLE, "Laya routed to an unexpected model")
        return profile

    def predict(self, state: dict[str, JsonValue], recipe: Recipe) -> EngineResult:
        questions = to_laya_questions(recipe)
        with self._lock:
            profile = recipe.model_profile
            if profile is ModelProfile.AUTO:
                profile = self._route(state, questions)
            agent, installed = self._load(profile)
            upstream = self._laya()
            cfg = agent.cfg
            max_len = int(cfg.get("max_len", installed.checkpoint.max_len))
            head_max_len = int(cfg.get("head_max_len", installed.checkpoint.head_max_len))
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    warnings = budget_warnings(
                        upstream, agent.tok, state, questions, max_len, head_max_len
                    )
                    response = agent.predict(state, questions)
            except ValueError as exc:
                if "head_max_len" in str(exc):
                    raise AppError(
                        ErrorCode.INVALID_RECIPE,
                        "a question has more option text than the model can read; "
                        "use fewer or shorter options",
                    ) from exc
                raise AppError(ErrorCode.ENGINE_FAILURE, "the model failed on this input") from exc
            except AppError:
                raise
            except Exception as exc:
                raise AppError(ErrorCode.ENGINE_FAILURE, "the model failed on this input") from exc
            outputs = normalize_answers(response, recipe)
            return EngineResult(
                model=self._info(recipe.model_profile, installed, agent),
                outputs=outputs,
                warnings=warnings,
            )
