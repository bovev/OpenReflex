"""The local HTTP API: ``/health/*`` and ``/v1/*``.

The browser UI and the MCP bridge are both clients of this API. Destructive
endpoints require ``?confirm=<exact id>`` so nothing is deleted by accident.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Any, Final

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, ConfigDict, Field, JsonValue
from starlette.exceptions import HTTPException as StarletteHTTPException

from openreflex import __version__
from openreflex.clients import (
    CONFIGURATION_POLICY,
    PRIVACY_NOTE,
    all_clients,
    resolve_mcp_executable,
)
from openreflex.context import AppContext
from openreflex.domain.decision import DecisionRequest, DecisionResult
from openreflex.domain.engine import EngineStatus
from openreflex.domain.errors import AppError, ErrorBody, ErrorCode, Issue
from openreflex.domain.recipe import DEFAULT_PROFILE, ModelProfile, Recipe
from openreflex.domain.validation import ValidationReport, parse_recipe, validate_recipe
from openreflex.history.store import WHAT_IS_STORED, HistoryEntry
from openreflex.identity import ATTRIBUTION, PRODUCT_NAME, RESULT_CONTRACT_VERSION
from openreflex.models.manager import ModelStatus
from openreflex.recipes.store import RecipeListing, parse_recipe_text, to_yaml
from openreflex.security.middleware import SecurityMiddleware
from openreflex.settings import Preferences

log = logging.getLogger("openreflex.api")

STATUS_CODES: Final[dict[ErrorCode, int]] = {
    ErrorCode.INVALID_RECIPE: 422,
    ErrorCode.RECIPE_NOT_FOUND: 404,
    ErrorCode.RECIPE_EXISTS: 409,
    ErrorCode.INVALID_INPUT: 422,
    ErrorCode.INPUT_TOO_LARGE: 413,
    ErrorCode.MODEL_NOT_READY: 409,
    ErrorCode.MODEL_NOT_FOUND: 404,
    ErrorCode.MODEL_BUSY: 409,
    ErrorCode.DOWNLOAD_FAILED: 502,
    ErrorCode.ENGINE_INCOMPATIBLE: 500,
    ErrorCode.ENGINE_FAILURE: 500,
    ErrorCode.QUEUE_FULL: 429,
    ErrorCode.TIMEOUT: 504,
    ErrorCode.HISTORY_DISABLED: 409,
    ErrorCode.UNAUTHORIZED: 401,
    ErrorCode.FORBIDDEN: 403,
    ErrorCode.NOT_FOUND: 404,
    ErrorCode.CONFIRMATION_REQUIRED: 400,
    ErrorCode.SERVICE_UNAVAILABLE: 503,
    ErrorCode.INTERNAL: 500,
}
RETRY_AFTER_S: Final = "2"


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ValidateRequest(_Body):
    recipe: dict[str, JsonValue] | None = None
    yaml: str | None = Field(default=None, max_length=64 * 1024)


class ImportRequest(_Body):
    yaml: str = Field(max_length=64 * 1024)
    overwrite: bool = False


class Health(BaseModel):
    status: str


class Readiness(BaseModel):
    ready: bool
    default_profile: ModelProfile
    reason: str | None = None


class HistoryStatus(BaseModel):
    enabled: bool
    what_is_stored: str


class StatusReport(BaseModel):
    product: str
    version: str
    contract_version: int
    attribution: str
    offline_ready: bool = Field(description="The default model is installed and verified.")
    default_profile: ModelProfile
    engine: EngineStatus
    models: list[ModelStatus]
    queue_depth: int
    queue_capacity: int
    history: HistoryStatus
    data_dir: str


class HistoryPage(BaseModel):
    entries: list[HistoryEntry]


class ClientConnection(BaseModel):
    client: str
    name: str
    config: dict[str, JsonValue]
    setup: list[str]
    restart: list[str]
    removal: list[str]
    schema_source: str
    schema_verified: str


class ConnectionListing(BaseModel):
    privacy_note: str
    configuration_policy: str
    clients: list[ClientConnection]


def _request_id(request: Request) -> str | None:
    return request.scope.get("state", {}).get("request_id")


def _error(request: Request, exc: AppError) -> JSONResponse:
    request.scope.setdefault("state", {})["error_code"] = exc.code
    body = ErrorBody(
        code=exc.code, message=exc.message, request_id=_request_id(request), issues=exc.issues
    )
    headers = {"Retry-After": RETRY_AFTER_S} if exc.code is ErrorCode.QUEUE_FULL else None
    return JSONResponse(
        body.model_dump(mode="json"), status_code=STATUS_CODES.get(exc.code, 500), headers=headers
    )


def _confirm(expected: str, confirm: str | None) -> None:
    if confirm != expected:
        raise AppError(
            ErrorCode.CONFIRMATION_REQUIRED,
            f"repeat the exact id in ?confirm= to delete '{expected}'",
        )


def create_app(
    ctx: AppContext,
    *,
    ui_dir: Path | None = None,
    mcp_executable_resolver: Callable[[], Path] | None = None,
) -> FastAPI:
    docs = ctx.settings.openapi
    app = FastAPI(
        title=f"{PRODUCT_NAME} local API",
        version=__version__,
        docs_url="/docs" if docs else None,
        redoc_url=None,
        openapi_url="/openapi.json" if docs else None,
    )
    app.state.ctx = ctx

    @app.exception_handler(AppError)
    async def _app_error(
        request: Request, exc: AppError
    ) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        return _error(request, exc)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        issues = [
            Issue(location=".".join(str(p) for p in e.get("loc", ())), message=str(e.get("msg")))
            for e in exc.errors()
        ]
        return _error(request, AppError(ErrorCode.INVALID_INPUT, "request is invalid", issues))

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(
        request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        code = ErrorCode.NOT_FOUND if exc.status_code == 404 else ErrorCode.INVALID_INPUT
        response = _error(request, AppError(code, str(exc.detail)))
        response.status_code = exc.status_code
        return response

    @app.exception_handler(Exception)
    async def _unexpected(
        request: Request, exc: Exception
    ) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        log.error(
            "unhandled error", extra={"event": "unhandled", "request_id": _request_id(request)}
        )
        return _error(request, AppError(ErrorCode.INTERNAL, "internal error"))

    # -- health ----------------------------------------------------------------

    @app.get("/health/live")
    def live() -> Health:  # pyright: ignore[reportUnusedFunction]
        return Health(status="ok")

    @app.get("/health/ready")
    def ready() -> Readiness:  # pyright: ignore[reportUnusedFunction]
        ok = ctx.models.is_ready(DEFAULT_PROFILE)
        return Readiness(
            ready=ok,
            default_profile=DEFAULT_PROFILE,
            reason=None if ok else "the default model is not installed",
        )

    # -- status & preferences -------------------------------------------------

    @app.get("/v1/status")
    def status() -> StatusReport:  # pyright: ignore[reportUnusedFunction]
        return StatusReport(
            product=PRODUCT_NAME,
            version=__version__,
            contract_version=RESULT_CONTRACT_VERSION,
            attribution=ATTRIBUTION,
            offline_ready=ctx.models.is_ready(DEFAULT_PROFILE),
            default_profile=DEFAULT_PROFILE,
            engine=ctx.engine.status(),
            models=ctx.models.statuses(),
            queue_depth=ctx.queue.depth,
            queue_capacity=ctx.queue.capacity,
            history=HistoryStatus(
                enabled=ctx.preferences.history_enabled, what_is_stored=WHAT_IS_STORED
            ),
            data_dir=str(ctx.settings.data_dir),
        )

    @app.get("/v1/preferences")
    def get_preferences() -> Preferences:  # pyright: ignore[reportUnusedFunction]
        return ctx.preferences

    @app.put("/v1/preferences")
    def put_preferences(prefs: Preferences) -> Preferences:  # pyright: ignore[reportUnusedFunction]
        return ctx.update_preferences(prefs)

    # -- models -----------------------------------------------------------------

    @app.get("/v1/models")
    def list_models() -> list[ModelStatus]:  # pyright: ignore[reportUnusedFunction]
        return ctx.models.statuses()

    @app.post("/v1/models/{profile}/download", status_code=202)
    def download_model(
        profile: ModelProfile,
    ) -> ModelStatus:  # pyright: ignore[reportUnusedFunction]
        return ctx.downloads.start(profile)

    @app.post("/v1/models/{profile}/verify")
    def verify_model(profile: ModelProfile) -> ModelStatus:  # pyright: ignore[reportUnusedFunction]
        return ctx.models.verify(profile)

    @app.delete("/v1/models/{profile}")
    def delete_model(  # pyright: ignore[reportUnusedFunction]
        profile: ModelProfile, confirm: Annotated[str | None, Query()] = None
    ) -> ModelStatus:
        _confirm(profile.value, confirm)
        return ctx.remove_model(profile)

    # -- recipes ----------------------------------------------------------------

    @app.get("/v1/recipes")
    def list_recipes() -> RecipeListing:  # pyright: ignore[reportUnusedFunction]
        return ctx.recipes.list_recipes()

    @app.post("/v1/recipes", status_code=201)
    def create_recipe(
        body: dict[str, JsonValue],
    ) -> Recipe:  # pyright: ignore[reportUnusedFunction]
        return ctx.recipes.create(parse_recipe(body))

    @app.post("/v1/recipes/validate")
    def validate(
        body: ValidateRequest,
    ) -> ValidationReport:  # pyright: ignore[reportUnusedFunction]
        if (body.recipe is None) == (body.yaml is None):
            raise AppError(ErrorCode.INVALID_INPUT, "send exactly one of 'recipe' or 'yaml'")
        if body.yaml is not None:
            try:
                return validate_recipe(parse_recipe_text(body.yaml).model_dump(mode="json"))
            except AppError as exc:
                return ValidationReport(valid=False, issues=exc.issues)
        return validate_recipe(body.recipe)

    @app.post("/v1/recipes/import", status_code=201)
    def import_recipe(body: ImportRequest) -> Recipe:  # pyright: ignore[reportUnusedFunction]
        return ctx.recipes.import_yaml(body.yaml, overwrite=body.overwrite)

    @app.get("/v1/recipes/{recipe_id}")
    def get_recipe(recipe_id: str) -> Recipe:  # pyright: ignore[reportUnusedFunction]
        return ctx.recipes.get(recipe_id)

    @app.get("/v1/recipes/{recipe_id}/export", response_class=PlainTextResponse)
    def export_recipe(recipe_id: str) -> PlainTextResponse:  # pyright: ignore[reportUnusedFunction]
        recipe = ctx.recipes.get(recipe_id)
        return PlainTextResponse(
            to_yaml(recipe),
            media_type="application/yaml",
            headers={"Content-Disposition": f'attachment; filename="{recipe.id}.yaml"'},
        )

    @app.put("/v1/recipes/{recipe_id}")
    def put_recipe(
        recipe_id: str, body: dict[str, JsonValue]
    ) -> Recipe:  # pyright: ignore[reportUnusedFunction]
        return ctx.recipes.update(recipe_id, parse_recipe(body))

    @app.delete("/v1/recipes/{recipe_id}", status_code=204)
    def delete_recipe(  # pyright: ignore[reportUnusedFunction]
        recipe_id: str, confirm: Annotated[str | None, Query()] = None
    ) -> None:
        ctx.recipes.get(recipe_id)
        _confirm(recipe_id, confirm)
        ctx.recipes.delete(recipe_id)

    # -- connections ----------------------------------------------------------

    @app.get("/v1/connections")
    def connections() -> ConnectionListing:  # pyright: ignore[reportUnusedFunction]
        executable = resolve_mcp_executable(mcp_executable_resolver)
        return ConnectionListing(
            privacy_note=PRIVACY_NOTE,
            configuration_policy=CONFIGURATION_POLICY,
            clients=[
                ClientConnection(
                    client=setup.client,
                    name=setup.name,
                    config=setup.config,
                    setup=list(setup.setup),
                    restart=list(setup.restart),
                    removal=list(setup.removal),
                    schema_source=setup.schema_source,
                    schema_verified=setup.schema_verified,
                )
                for setup in all_clients(executable)
            ],
        )

    # -- decisions & history ------------------------------------------------------

    @app.post("/v1/decisions")
    async def decide(
        request: Request, body: DecisionRequest
    ) -> DecisionResult:  # pyright: ignore[reportUnusedFunction]
        request_id = _request_id(request)

        def run() -> DecisionResult:
            return ctx.decisions.run(body.recipe_id, body.input, request_id=request_id)

        result = await ctx.queue.run(run, ctx.settings.inference_timeout_s)
        if ctx.preferences.history_enabled:
            ctx.history.record(result)
        return result

    @app.get("/v1/history")
    def history(
        limit: Annotated[int, Query(ge=1, le=500)] = 100,
    ) -> HistoryPage:  # pyright: ignore[reportUnusedFunction]
        if not ctx.preferences.history_enabled:
            raise AppError(ErrorCode.HISTORY_DISABLED, "history is turned off")
        return HistoryPage(entries=ctx.history.list(limit))

    @app.delete("/v1/history", status_code=204)
    def clear_history() -> None:  # pyright: ignore[reportUnusedFunction]
        ctx.history.clear()

    @app.post("/v1/shutdown", status_code=202)
    def shutdown() -> Health:  # pyright: ignore[reportUnusedFunction]
        stop: Callable[[], None] | None = getattr(app.state, "request_shutdown", None)
        if stop is None:
            raise AppError(
                ErrorCode.SERVICE_UNAVAILABLE, "this instance cannot be stopped remotely"
            )
        stop()
        return Health(status="stopping")

    if ui_dir is not None and (ui_dir / "index.html").is_file():
        _mount_ui(app, ui_dir)

    return app


def _mount_ui(app: FastAPI, ui_dir: Path) -> None:
    from fastapi.staticfiles import StaticFiles
    from starlette.responses import FileResponse

    app.mount("/assets", StaticFiles(directory=ui_dir / "assets"), name="assets")
    index = ui_dir / "index.html"

    @app.get("/", include_in_schema=False)
    def root() -> FileResponse:  # pyright: ignore[reportUnusedFunction]
        return FileResponse(index, media_type="text/html")


def secured(ctx: AppContext, app: Any) -> Callable[..., Any]:
    """Wrap the app in the security middleware (outermost layer)."""
    return SecurityMiddleware(
        app,
        token=lambda: ctx.token,
        port=lambda: ctx.port,
        max_body=ctx.settings.max_request_bytes,
    )
