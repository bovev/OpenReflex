"""Hardened YAML reading and writing for recipes.

Recipes are small, plain data. The loader is PyYAML's safe loader with extra
restrictions:

- input size is capped before parsing;
- anchors, aliases, and merge keys are rejected, so "billion laughs" style
  expansion is impossible;
- explicit tags are rejected, so only plain maps, lists, and scalars load;
- duplicate mapping keys are rejected rather than silently overwritten;
- nesting depth is capped.
"""

from __future__ import annotations

from typing import Any, Final, cast

import yaml
from yaml.events import AliasEvent, CollectionStartEvent, Event, ScalarEvent
from yaml.nodes import MappingNode, Node

MAX_RECIPE_BYTES: Final = 64 * 1024
MAX_DEPTH: Final = 16
_STANDARD_TAGS: Final = frozenset(
    {
        "tag:yaml.org,2002:str",
        "tag:yaml.org,2002:int",
        "tag:yaml.org,2002:float",
        "tag:yaml.org,2002:bool",
        "tag:yaml.org,2002:null",
        "tag:yaml.org,2002:seq",
        "tag:yaml.org,2002:map",
    }
)


class RecipeYamlError(ValueError):
    """The document is not acceptable recipe YAML. Messages never quote content."""


class _RestrictedLoader(yaml.SafeLoader):
    def __init__(self, stream: str) -> None:
        super().__init__(stream)
        self._depth = 0

    def parse_node(self, block: bool = False, indentless_sequence: bool = False) -> Event:  # type: ignore[override]
        event: Event = super().parse_node(block, indentless_sequence)  # type: ignore[misc]
        if isinstance(event, AliasEvent):
            raise RecipeYamlError("YAML aliases are not allowed")
        if isinstance(event, ScalarEvent | CollectionStartEvent):
            if getattr(event, "anchor", None):
                raise RecipeYamlError("YAML anchors are not allowed")
            tag = getattr(event, "tag", None)
            if tag is not None and tag not in ("!", *_STANDARD_TAGS):
                raise RecipeYamlError("YAML tags are not allowed")
        return cast(Event, event)

    def compose_node(self, parent: Node | None, index: object) -> Node | None:  # type: ignore[override]
        self._depth += 1
        try:
            if self._depth > MAX_DEPTH:
                raise RecipeYamlError(f"YAML nesting exceeds {MAX_DEPTH} levels")
            return super().compose_node(parent, index)  # type: ignore[misc]
        finally:
            self._depth -= 1

    def construct_mapping(self, node: MappingNode, deep: bool = False) -> dict[Any, Any]:  # type: ignore[override]
        seen: set[object] = set()
        for key_node, _ in node.value:
            if key_node.tag == "tag:yaml.org,2002:merge":
                raise RecipeYamlError("YAML merge keys are not allowed")
            key: object = self.construct_object(key_node, deep=True)  # type: ignore[misc]
            if not isinstance(key, str):
                raise RecipeYamlError("mapping keys must be strings")
            if key in seen:
                raise RecipeYamlError(f"duplicate key {key!r}")
            seen.add(key)
        return super().construct_mapping(node, deep=True)  # type: ignore[misc]


def load_recipe_yaml(text: str | bytes) -> object:
    """Parse one YAML document into plain Python data."""
    raw = text.encode("utf-8") if isinstance(text, str) else text
    if len(raw) > MAX_RECIPE_BYTES:
        raise RecipeYamlError(f"recipe exceeds {MAX_RECIPE_BYTES} bytes")
    try:
        decoded = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise RecipeYamlError("recipe must be UTF-8 text") from exc
    loader = _RestrictedLoader(decoded)
    try:
        return loader.get_single_data()
    except RecipeYamlError:
        raise
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        where = f" at line {mark.line + 1}, column {mark.column + 1}" if mark else ""
        raise RecipeYamlError(f"recipe is not valid YAML{where}") from exc
    finally:
        loader.dispose()  # pyright: ignore[reportUnknownMemberType]


def dump_recipe_yaml(data: object) -> str:
    return yaml.safe_dump(
        data, sort_keys=False, allow_unicode=True, default_flow_style=False, width=100
    )
