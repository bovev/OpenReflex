"""Stable application errors shared by the API, MCP bridge, and UI.

Error codes are part of the public contract. Messages are safe to show and
log: they never include request bodies, decision content, or secrets.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict


class ErrorCode(StrEnum):
    INVALID_RECIPE = "invalid_recipe"
    RECIPE_NOT_FOUND = "recipe_not_found"
    RECIPE_EXISTS = "recipe_exists"
    INVALID_INPUT = "invalid_input"
    INPUT_TOO_LARGE = "input_too_large"
    MODEL_NOT_READY = "model_not_ready"
    MODEL_NOT_FOUND = "model_not_found"
    MODEL_BUSY = "model_busy"
    DOWNLOAD_FAILED = "download_failed"
    ENGINE_INCOMPATIBLE = "engine_incompatible"
    ENGINE_FAILURE = "engine_failure"
    QUEUE_FULL = "queue_full"
    TIMEOUT = "timeout"
    HISTORY_DISABLED = "history_disabled"
    UNAUTHORIZED = "unauthorized"
    FORBIDDEN = "forbidden"
    NOT_FOUND = "not_found"
    CONFIRMATION_REQUIRED = "confirmation_required"
    INTERNAL = "internal"


class Issue(BaseModel):
    """One actionable problem, e.g. a recipe validation failure."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    location: str
    message: str


class AppError(Exception):
    """An expected failure with a stable code and a user-safe message."""

    def __init__(self, code: ErrorCode, message: str, issues: list[Issue] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.issues = issues or []


class ErrorBody(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    code: ErrorCode
    message: str
    request_id: str | None = None
    issues: list[Issue] = []
