"""Every MCP tool, invoked through a real MCP client session against the real API app."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, cast

import anyio
from mcp import ClientSession, types

from openreflex_mcp.client import ServiceClient
from openreflex_mcp.tools import TOOLS

from .conftest import SpyEngine, session_for

NEW_RECIPE: dict[str, Any] = {
    "schema_version": 1,
    "id": "lead-check",
    "name": "Lead check",
    "description": "Is this a sales lead?",
    "model_profile": "typed-decisions",
    "questions": {"lead": {"type": "noul", "instructions": "Is this a new sales lead?"}},
}
NEW_YAML = """\
schema_version: 1
id: yaml-recipe
name: YAML recipe
description: Imported from YAML.
questions:
  spam:
    type: noul
    instructions: Is this spam?
"""


def run(client: ServiceClient, body: Callable[[ClientSession], Awaitable[None]]) -> None:
    async def main() -> None:
        async with session_for(client) as session:
            await body(session)

    anyio.run(main)


async def call(session: ClientSession, name: str, **arguments: Any) -> types.CallToolResult:
    return await session.call_tool(name, arguments)


def ok(result: types.CallToolResult) -> dict[str, Any]:
    assert not result.isError, result.content
    assert result.structuredContent is not None
    return result.structuredContent


def error(result: types.CallToolResult) -> dict[str, Any]:
    assert result.isError
    assert result.structuredContent is not None
    err = result.structuredContent["error"]
    assert "Traceback" not in str(result.content)
    return err


def _property_names(schema: object) -> set[str]:
    names: set[str] = set()
    if isinstance(schema, dict):
        for key, value in cast(dict[str, object], schema).items():
            if key == "properties" and isinstance(value, dict):
                names.update(cast(dict[str, object], value))
            names |= _property_names(cast(object, value))
    elif isinstance(schema, list):
        for item in cast(list[object], schema):
            names |= _property_names(item)
    return names


def test_lists_every_tool_with_strict_schemas_and_mutation_hints(
    service_client: ServiceClient,
) -> None:
    async def body(session: ClientSession) -> None:
        tools = {t.name: t for t in (await session.list_tools()).tools}
        assert set(tools) == {
            "list_recipes",
            "get_recipe",
            "validate_recipe",
            "run_decision",
            "save_recipe",
            "delete_recipe",
        }
        for tool in tools.values():
            assert tool.inputSchema.get("additionalProperties") is False
            assert tool.description and "local" in tool.description
            hints = tool.annotations
            assert hints is not None and hints.openWorldHint is False
            # No tool takes a file, path, URL, or other fetchable source.
            banned = {"path", "file", "filename", "url", "uri", "source", "attachment"}
            assert not banned & _property_names(tool.inputSchema)
        for name in ("list_recipes", "get_recipe", "validate_recipe", "run_decision"):
            assert tools[name].annotations.readOnlyHint is True  # type: ignore[union-attr]
        for name in ("save_recipe", "delete_recipe"):
            hints = tools[name].annotations
            assert hints is not None
            assert hints.readOnlyHint is False and hints.destructiveHint is True
            assert tools[name].description.startswith(("WRITES", "PERMANENTLY"))  # type: ignore[union-attr]

    run(service_client, body)
    assert len(TOOLS) == 6


def test_list_and_get_recipes(service_client: ServiceClient) -> None:
    async def body(session: ClientSession) -> None:
        listing = ok(await call(session, "list_recipes"))
        ids = {r["id"] for r in listing["recipes"]}
        assert "email-triage" in ids
        first = listing["recipes"][0]
        assert set(first) == {"id", "name", "description", "model_profile", "example"}

        recipe = ok(await call(session, "get_recipe", recipe_id="email-triage"))
        assert recipe["questions"]["department"]["type"] == "choice"

        missing = error(await call(session, "get_recipe", recipe_id="no-such-recipe"))
        assert missing["code"] == "recipe_not_found"

    run(service_client, body)


def test_ids_cannot_address_other_routes(service_client: ServiceClient) -> None:
    async def body(session: ClientSession) -> None:
        for bad in ("../status", "email-triage/export", "email-triage?x=1", "Email", ""):
            err = error(await call(session, "get_recipe", recipe_id=bad))
            assert err["code"] == "invalid_input"
            assert err["issues"][0]["location"] == "recipe_id"

    run(service_client, body)


def test_validate_recipe(service_client: ServiceClient) -> None:
    async def body(session: ClientSession) -> None:
        assert ok(await call(session, "validate_recipe", recipe=NEW_RECIPE))["valid"] is True
        assert ok(await call(session, "validate_recipe", yaml=NEW_YAML))["valid"] is True

        broken = ok(await call(session, "validate_recipe", recipe={**NEW_RECIPE, "typo": 1}))
        assert broken["valid"] is False and broken["issues"]

        bad_yaml = ok(await call(session, "validate_recipe", yaml="a: &x 1\nb: *x\n"))
        assert bad_yaml["valid"] is False

        for arguments in ({}, {"recipe": NEW_RECIPE, "yaml": NEW_YAML}):
            err = error(await session.call_tool("validate_recipe", arguments))
            assert err["code"] == "invalid_input"

        # Validation never saves.
        listing = ok(await call(session, "list_recipes"))
        assert "lead-check" not in {r["id"] for r in listing["recipes"]}

    run(service_client, body)


def test_run_decision_text_and_json(service_client: ServiceClient, engine: SpyEngine) -> None:
    async def body(session: ClientSession) -> None:
        text = ok(
            await call(
                session, "run_decision", recipe_id="email-triage", input="Refund invoice 4471."
            )
        )
        assert text["status"] == "completed"
        assert text["contract_version"] == 1
        assert set(text["answers"]) == {"department", "urgent", "priority"}
        assert text["model"]["profile"] == "typed-decisions"
        assert text["model"]["checkpoint"] and text["model"]["revision"]
        assert text["review"] in {"ok", "needs_review"}

        structured = ok(
            await call(
                session,
                "run_decision",
                recipe_id="email-triage",
                input={"subject": "Invoice", "body": "Charged twice"},
            )
        )
        assert structured["status"] == "completed"

        low = ok(
            await call(session, "run_decision", recipe_id="email-triage", input="hi [fake:low]")
        )
        assert low["review"] == "needs_review"

        truncated = ok(
            await call(
                session, "run_decision", recipe_id="email-triage", input="long [fake:truncate]"
            )
        )
        assert truncated["warnings"]

    run(service_client, body)
    assert engine.states[0] == {"text": "Refund invoice 4471."}
    assert engine.states[1] == {"subject": "Invoice", "body": "Charged twice"}


def test_paths_and_urls_are_not_decision_sources(
    service_client: ServiceClient, engine: SpyEngine
) -> None:
    inert = ["C:\\Windows\\win.ini", "file:///etc/passwd", "https://example.com/doc"]

    async def body(session: ClientSession) -> None:
        for extra in ("path", "file", "url"):
            err = error(
                await session.call_tool(
                    "run_decision",
                    {"recipe_id": "email-triage", "input": "x", extra: "C:\\secret.txt"},
                )
            )
            assert err["code"] == "invalid_input"
            assert err["issues"][0]["location"] == extra

        # Path- or URL-looking text is analyzed as text, never opened or fetched.
        for value in inert:
            result = ok(await call(session, "run_decision", recipe_id="email-triage", input=value))
            assert result["status"] == "completed"

    run(service_client, body)
    assert engine.states == [{"text": value} for value in inert]


def test_run_decision_errors_are_structured(service_client: ServiceClient) -> None:
    async def body(session: ClientSession) -> None:
        cases: list[tuple[dict[str, Any], str]] = [
            ({"recipe_id": "email-triage", "input": "   "}, "invalid_input"),
            ({"recipe_id": "email-triage", "input": 42}, "invalid_input"),
            ({"recipe_id": "email-triage"}, "invalid_input"),
            ({"recipe_id": "missing", "input": "x"}, "recipe_not_found"),
            ({"recipe_id": "email-triage", "input": "x [fake:fail]"}, "engine_failure"),
            ({"recipe_id": "email-triage", "input": "x" * 300_000}, "input_too_large"),
        ]
        for arguments, code in cases:
            assert error(await session.call_tool("run_decision", arguments))["code"] == code

        unknown = error(await session.call_tool("run_shell", {"command": "dir"}))
        assert unknown["code"] == "not_found"

    run(service_client, body)


def test_save_recipe_create_replace_and_yaml(service_client: ServiceClient) -> None:
    async def body(session: ClientSession) -> None:
        created = ok(await call(session, "save_recipe", recipe=NEW_RECIPE))
        assert created == {"saved": True, "recipe": {**created["recipe"]}}
        assert created["recipe"]["id"] == "lead-check"

        taken = error(await call(session, "save_recipe", recipe=NEW_RECIPE))
        assert taken["code"] == "recipe_exists"

        renamed = {**NEW_RECIPE, "name": "Lead check v2"}
        replaced = ok(await call(session, "save_recipe", recipe=renamed, replace=True))
        assert replaced["recipe"]["name"] == "Lead check v2"
        stored = ok(await call(session, "get_recipe", recipe_id="lead-check"))
        assert stored["name"] == "Lead check v2"

        # replace=True also creates a recipe that does not exist yet.
        fresh = {**NEW_RECIPE, "id": "fresh-one"}
        assert ok(await call(session, "save_recipe", recipe=fresh, replace=True))["saved"]

        invalid = error(
            await call(session, "save_recipe", recipe={**NEW_RECIPE, "id": "Bad Id"}, replace=True)
        )
        assert invalid["code"] in {"invalid_recipe", "invalid_input"}
        assert invalid["issues"]

        imported = ok(await call(session, "save_recipe", yaml=NEW_YAML))
        assert imported["recipe"]["id"] == "yaml-recipe"
        again = error(await call(session, "save_recipe", yaml=NEW_YAML))
        assert again["code"] == "recipe_exists"
        assert ok(await call(session, "save_recipe", yaml=NEW_YAML, replace=True))["saved"]

        not_bool = error(await call(session, "save_recipe", recipe=NEW_RECIPE, replace="yes"))
        assert not_bool["code"] == "invalid_input"

    run(service_client, body)


def test_delete_recipe_requires_exact_confirmation(service_client: ServiceClient) -> None:
    async def body(session: ClientSession) -> None:
        ok(await call(session, "save_recipe", recipe=NEW_RECIPE))

        refused = error(
            await call(
                session, "delete_recipe", recipe_id="lead-check", confirm_recipe_id="lead-chec"
            )
        )
        assert refused["code"] == "confirmation_required"
        assert ok(await call(session, "get_recipe", recipe_id="lead-check"))

        deleted = ok(
            await call(
                session, "delete_recipe", recipe_id="lead-check", confirm_recipe_id="lead-check"
            )
        )
        assert deleted == {"deleted": True, "recipe_id": "lead-check"}
        gone = error(await call(session, "get_recipe", recipe_id="lead-check"))
        assert gone["code"] == "recipe_not_found"

        missing = error(
            await call(
                session, "delete_recipe", recipe_id="lead-check", confirm_recipe_id="lead-check"
            )
        )
        assert missing["code"] == "recipe_not_found"

    run(service_client, body)
