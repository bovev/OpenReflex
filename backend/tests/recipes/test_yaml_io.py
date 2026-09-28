from __future__ import annotations

import pytest

from openreflex.recipes.yaml_io import (
    MAX_DEPTH,
    MAX_RECIPE_BYTES,
    RecipeYamlError,
    dump_recipe_yaml,
    load_recipe_yaml,
)


def test_plain_document_loads() -> None:
    assert load_recipe_yaml("a: 1\nb: [x, y]\nc: {d: true}\n") == {
        "a": 1,
        "b": ["x", "y"],
        "c": {"d": True},
    }


def test_bytes_and_bom_accepted() -> None:
    assert load_recipe_yaml("\ufeffa: 1".encode()) == {"a": 1}


@pytest.mark.parametrize(
    "doc",
    [
        "a: &x 1\nb: *x\n",
        "a: &x [1, 2]\n",
        "base: &b {k: 1}\nother:\n  <<: *b\n",
    ],
)
def test_anchors_aliases_and_merges_rejected(doc: str) -> None:
    with pytest.raises(RecipeYamlError):
        load_recipe_yaml(doc)


def test_billion_laughs_rejected_before_expansion() -> None:
    doc = 'a: &a ["lol","lol","lol"]\nb: &b [*a,*a,*a]\nc: &c [*b,*b,*b]\n'
    with pytest.raises(RecipeYamlError, match=r"anchors|aliases"):
        load_recipe_yaml(doc)


@pytest.mark.parametrize(
    "doc",
    [
        "a: !!python/object:os.system {}\n",
        "a: !!python/name:os.system\n",
        "a: !custom value\n",
        "a: !!binary aGVsbG8=\n",
        "a: !!set {x: null}\n",
        "a: !!timestamp 2001-12-14\n",
    ],
)
def test_tags_rejected(doc: str) -> None:
    with pytest.raises(RecipeYamlError, match="tags"):
        load_recipe_yaml(doc)


def test_standard_explicit_tags_allowed() -> None:
    assert load_recipe_yaml("a: !!str 1\n") == {"a": "1"}


def test_duplicate_keys_rejected() -> None:
    with pytest.raises(RecipeYamlError, match="duplicate"):
        load_recipe_yaml("id: a\nid: b\n")
    with pytest.raises(RecipeYamlError, match="duplicate"):
        load_recipe_yaml("q:\n  x: 1\n  x: 2\n")


def test_non_string_keys_rejected() -> None:
    with pytest.raises(RecipeYamlError, match="keys"):
        load_recipe_yaml("1: a\n")


def test_depth_limit() -> None:
    ok = "a: " + "[" * (MAX_DEPTH - 2) + "]" * (MAX_DEPTH - 2)
    load_recipe_yaml(ok)
    deep = "a: " + "[" * (MAX_DEPTH + 5) + "]" * (MAX_DEPTH + 5)
    with pytest.raises(RecipeYamlError, match="nesting"):
        load_recipe_yaml(deep)


def test_size_limit() -> None:
    with pytest.raises(RecipeYamlError, match="exceeds"):
        load_recipe_yaml("a: " + "x" * MAX_RECIPE_BYTES)


def test_invalid_yaml_reports_position_without_content() -> None:
    with pytest.raises(RecipeYamlError) as info:
        load_recipe_yaml("a: [unclosed secret-value\n")
    assert "line" in str(info.value)
    assert "secret-value" not in str(info.value)


def test_non_utf8_rejected() -> None:
    with pytest.raises(RecipeYamlError, match="UTF-8"):
        load_recipe_yaml(b"a: \xff\xfe")


def test_multiple_documents_rejected() -> None:
    with pytest.raises(RecipeYamlError):
        load_recipe_yaml("a: 1\n---\nb: 2\n")


def test_dump_preserves_order_and_round_trips() -> None:
    data = {"z": 1, "a": {"y": "ä", "b": [1, 2]}}
    text = dump_recipe_yaml(data)
    assert text.index("z") < text.index("a:")
    assert load_recipe_yaml(text) == data
