"""Deterministic fake engine for tests, UI development, and packaging smoke tests.

Output depends only on the input and the recipe, so it's stable across runs
and machines. Markers in the input text force specific states:

    [fake:high]          peaked distributions (confidence close to 1)
    [fake:low]           flat distributions (low confidence)
    [fake:truncate]      reports that the input was truncated
    [fake:fail]          raises an engine failure
    [fake:incompatible]  raises an engine compatibility error
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from collections.abc import Iterable

from pydantic import JsonValue

from openreflex.domain.decision import DecisionWarning, Device, ModelInfo, WarningCode
from openreflex.domain.engine import (
    ChoiceOutput,
    EngineResult,
    EngineStatus,
    NoulOutput,
    QuestionOutput,
    ScoreOutput,
)
from openreflex.domain.errors import AppError, ErrorCode
from openreflex.domain.recipe import ChoiceQuestion, ModelProfile, NoulQuestion, Recipe

FAKE_REVISION = "fake-0"


def entropy_confidence(probs: list[float]) -> float:
    k = len(probs)
    if k < 2:
        return 1.0
    h = -sum(p * math.log(max(p, 1e-12)) for p in probs)
    return max(0.0, min(1.0, 1.0 - h / math.log(k)))


def _softmax(logits: list[float]) -> list[float]:
    top = max(logits)
    exps = [math.exp(x - top) for x in logits]
    total = sum(exps)
    return [e / total for e in exps]


class FakeEngine:
    def __init__(
        self,
        ready_profiles: Iterable[ModelProfile] | None = None,
        delay_s: float = 0.0,
    ) -> None:
        self._ready = set(ModelProfile if ready_profiles is None else ready_profiles)
        self._delay_s = delay_s
        self._loaded: ModelProfile | None = None
        self.load_count = 0
        self.predict_count = 0

    def _resolve(self, profile: ModelProfile) -> ModelProfile:
        return ModelProfile.ENGLISH if profile is ModelProfile.AUTO else profile

    def _info(self, profile: ModelProfile) -> ModelInfo:
        resolved = self._resolve(profile)
        return ModelInfo(
            profile=profile,
            resolved_profile=resolved,
            checkpoint=f"fake/{resolved.value}",
            revision=FAKE_REVISION,
            device=Device.FAKE,
        )

    def ensure_model(self, profile: ModelProfile) -> ModelInfo:
        resolved = self._resolve(profile)
        if resolved not in self._ready:
            raise AppError(ErrorCode.MODEL_NOT_READY, f"model '{resolved.value}' is not installed")
        if self._loaded is not resolved:
            self._loaded = resolved
            self.load_count += 1
        return self._info(profile)

    def unload(self) -> None:
        self._loaded = None

    def status(self) -> EngineStatus:
        return EngineStatus(
            engine="fake",
            loaded_profile=self._loaded,
            loaded_checkpoint=f"fake/{self._loaded.value}" if self._loaded else None,
        )

    def predict(self, state: dict[str, JsonValue], recipe: Recipe) -> EngineResult:
        info = self.ensure_model(recipe.model_profile)
        self.predict_count += 1
        text = json.dumps(state, sort_keys=True, ensure_ascii=False)
        if "[fake:fail]" in text:
            raise AppError(ErrorCode.ENGINE_FAILURE, "the engine failed to produce a decision")
        if "[fake:incompatible]" in text:
            raise AppError(ErrorCode.ENGINE_INCOMPATIBLE, "engine output was incompatible")
        if self._delay_s:
            time.sleep(self._delay_s)

        sharpness = 12.0 if "[fake:high]" in text else 0.05 if "[fake:low]" in text else 2.5
        outputs: dict[str, QuestionOutput] = {}
        for qid, question in recipe.questions.items():
            k = 2 if isinstance(question, NoulQuestion) else len(question.criteria)
            seed = hashlib.sha256(f"{qid}\0{text}".encode()).digest()
            logits = [(seed[i % len(seed)] / 255.0) for i in range(k)]
            top = max(range(k), key=lambda i: logits[i])
            logits = [sharpness * (x + (1.0 if i == top else 0.0)) for i, x in enumerate(logits)]
            probs = [round(p, 6) for p in _softmax(logits)]
            if isinstance(question, NoulQuestion):
                p_true = probs[1]
                outputs[qid] = NoulOutput(
                    probability_true=p_true, confidence=max(p_true, 1 - p_true)
                )
            elif isinstance(question, ChoiceQuestion):
                outputs[qid] = ChoiceOutput(
                    probabilities=dict(zip(question.criteria, probs, strict=True)),
                    confidence=entropy_confidence(probs),
                )
            else:
                outputs[qid] = ScoreOutput(
                    probabilities=probs,
                    expected=sum(i * p for i, p in enumerate(probs)),
                    confidence=entropy_confidence(probs),
                )

        warnings: list[DecisionWarning] = []
        if "[fake:truncate]" in text:
            warnings.append(
                DecisionWarning(
                    code=WarningCode.INPUT_TRUNCATED,
                    message="Only the first part of the input fit in the model's context.",
                )
            )
        return EngineResult(model=info, outputs=outputs, warnings=warnings)
