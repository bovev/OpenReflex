"""MCP tool definitions: strict argument models mapped onto the local ``/v1`` API.

There is deliberately no tool that reads files, fetches URLs, runs code, or
proxies arbitrary HTTP. Decision input is only the text or JSON object the
caller passes; any path or URL inside it is analyzed as inert text.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Final, Self

from mcp import types
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, model_validator

from openreflex.domain.errors import ErrorCode, Issue
from openreflex.domain.recipe import RecipeId
from openreflex.identity import PRODUCT_NAME
from openreflex_mcp.client import BridgeError, ServiceClient, quote_id

MAX_YAML_CHARS: Final = 64 * 1024
_LOCAL: Final = f"Runs on the local {PRODUCT_NAME} service on this computer."


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class NoArgs(_Args):
    pass


class RecipeRef(_Args):
    recipe_id: RecipeId = Field(description="Recipe id, lowercase kebab-case, e.g. email-triage.")


class RecipeSource(_Args):
    recipe: dict[str, Any] | None = Field(
        default=None, description="The recipe as a JSON object (schema_version 1)."
    )
    yaml: str | None = Field(
        default=None, max_length=MAX_YAML_CHARS, description="The recipe as YAML text."
    )

    @model_validator(mode="after")
    def _exactly_one(self) -> Self:
        if (self.recipe is None) == (self.yaml is None):
            raise ValueError("send exactly one of 'recipe' or 'yaml'")
        return self


class SaveArgs(RecipeSource):
    replace: bool = Field(
        default=False,
        description="Set true to overwrite an existing recipe with the same id. "
        "When false, saving fails if the id is taken.",
    )


class RunArgs(_Args):
    recipe_id: RecipeId = Field(description="Id of the saved recipe to run.")
    input: str | dict[str, Any] = Field(
        description="The content to decide on: plain text, or a JSON object of fields. "
        "It is analyzed as given. Paths or URLs inside it are treated as text and are "
        "never opened or fetched."
    )


class DeleteArgs(RecipeRef):
    confirm_recipe_id: str = Field(description="Repeat the exact recipe id to confirm deletion.")


Handler = Callable[[ServiceClient, Any], dict[str, Any]]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    title: str
    description: str
    args: type[_Args]
    handler: Handler
    read_only: bool
    destructive: bool = False
    idempotent: bool = True

    def definition(self) -> types.Tool:
        schema = self.args.model_json_schema()
        schema.pop("title", None)
        return types.Tool(
            name=self.name,
            title=self.title,
            description=self.description,
            inputSchema=schema,
            annotations=types.ToolAnnotations(
                title=self.title,
                readOnlyHint=self.read_only,
                destructiveHint=None if self.read_only else self.destructive,
                idempotentHint=self.idempotent,
                openWorldHint=False,
            ),
        )


def _list_recipes(client: ServiceClient, _: NoArgs) -> dict[str, Any]:
    listing = client.request("GET", "/v1/recipes")
    keep = ("id", "name", "description", "model_profile", "example")
    return {
        "recipes": [{k: r[k] for k in keep} for r in listing["recipes"]],
        "invalid_files": listing["invalid"],
    }


def _get_recipe(client: ServiceClient, args: RecipeRef) -> dict[str, Any]:
    return client.request("GET", f"/v1/recipes/{quote_id(args.recipe_id)}")


def _validate_recipe(client: ServiceClient, args: RecipeSource) -> dict[str, Any]:
    body = {"recipe": args.recipe} if args.recipe is not None else {"yaml": args.yaml}
    return client.request("POST", "/v1/recipes/validate", body=body)


def _run_decision(client: ServiceClient, args: RunArgs) -> dict[str, Any]:
    return client.request(
        "POST", "/v1/decisions", body={"recipe_id": args.recipe_id, "input": args.input}
    )


_ID: Final[TypeAdapter[str]] = TypeAdapter(RecipeId)


def _save_recipe(client: ServiceClient, args: SaveArgs) -> dict[str, Any]:
    if args.yaml is not None:
        recipe = client.request(
            "POST", "/v1/recipes/import", body={"yaml": args.yaml, "overwrite": args.replace}
        )
    else:
        recipe = None
        if args.replace:
            try:
                recipe_id = _ID.validate_python(args.recipe.get("id") if args.recipe else None)
            except ValidationError:
                recipe_id = None  # let the create call report the invalid id
            if recipe_id is not None:
                try:
                    recipe = client.request(
                        "PUT", f"/v1/recipes/{quote_id(recipe_id)}", body=args.recipe
                    )
                except BridgeError as exc:
                    if exc.error.code is not ErrorCode.RECIPE_NOT_FOUND:
                        raise
        if recipe is None:
            recipe = client.request("POST", "/v1/recipes", body=args.recipe)
    return {"saved": True, "recipe": recipe}


def _delete_recipe(client: ServiceClient, args: DeleteArgs) -> dict[str, Any]:
    if args.confirm_recipe_id != args.recipe_id:
        raise BridgeError.of(
            ErrorCode.CONFIRMATION_REQUIRED,
            "confirm_recipe_id must repeat the exact recipe id",
            [Issue(location="confirm_recipe_id", message="does not match recipe_id")],
        )
    client.request(
        "DELETE",
        f"/v1/recipes/{quote_id(args.recipe_id)}",
        query={"confirm": args.recipe_id},
    )
    return {"deleted": True, "recipe_id": args.recipe_id}


TOOLS: Final[tuple[ToolSpec, ...]] = (
    ToolSpec(
        name="list_recipes",
        title="List decision recipes",
        description=f"Lists the saved decision recipes: id, name, description, and model "
        f"profile. {_LOCAL} Read-only.",
        args=NoArgs,
        handler=_list_recipes,
        read_only=True,
    ),
    ToolSpec(
        name="get_recipe",
        title="Get a decision recipe",
        description=f"Returns one saved recipe with its questions, criteria, and review "
        f"policy. {_LOCAL} Read-only.",
        args=RecipeRef,
        handler=_get_recipe,
        read_only=True,
    ),
    ToolSpec(
        name="validate_recipe",
        title="Validate a proposed recipe",
        description=f"Checks a proposed recipe (JSON object or YAML) and returns actionable "
        f"issues and warnings. Nothing is saved. {_LOCAL} Read-only.",
        args=RecipeSource,
        handler=_validate_recipe,
        read_only=True,
    ),
    ToolSpec(
        name="run_decision",
        title="Run a decision recipe",
        description=f"Runs a saved recipe against the text or JSON object you pass, using the "
        f"Laya model on this computer. {_LOCAL} Returns answers with probabilities, "
        "a review state, warnings, the model checkpoint used, and latency. "
        "'needs_review' means a person should check the result. Review state comes "
        "from a confidence policy and is not a guarantee of correctness. Probabilities "
        "may be over-confident. Changes nothing. Takes no file paths or URLs.",
        args=RunArgs,
        handler=_run_decision,
        read_only=True,
        idempotent=False,
    ),
    ToolSpec(
        name="save_recipe",
        title="Save a decision recipe",
        description=f"WRITES a recipe to local storage: creates it, or overwrites an "
        f"existing recipe when replace is true. The recipe is validated first. "
        f"{_LOCAL} Ask the user before saving.",
        args=SaveArgs,
        handler=_save_recipe,
        read_only=False,
        destructive=True,
        idempotent=True,
    ),
    ToolSpec(
        name="delete_recipe",
        title="Delete a decision recipe",
        description=f"PERMANENTLY DELETES a saved recipe. Requires the exact id twice. "
        f"{_LOCAL} Ask the user before deleting.",
        args=DeleteArgs,
        handler=_delete_recipe,
        read_only=False,
        destructive=True,
        idempotent=True,
    ),
)
BY_NAME: Final = {tool.name: tool for tool in TOOLS}


def parse_args(spec: ToolSpec, arguments: dict[str, Any]) -> _Args:
    try:
        return spec.args.model_validate(arguments)
    except ValidationError as exc:
        issues = [
            Issue(
                location=".".join(str(p) for p in e["loc"]) or "arguments",
                message=e["msg"],
            )
            for e in exc.errors(include_url=False, include_input=False)
        ]
        raise BridgeError.of(ErrorCode.INVALID_INPUT, "tool arguments are invalid", issues) from exc
