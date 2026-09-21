from __future__ import annotations

import threading
from pathlib import Path

import pytest

from openreflex.domain.errors import AppError, ErrorCode
from openreflex.domain.recipe import Recipe
from openreflex.recipes import store as store_module
from openreflex.recipes.store import (
    SEED_MARKER,
    RecipeStore,
    bundled_examples,
    parse_recipe_text,
    to_yaml,
)

SIMPLE = """\
schema_version: 1
id: simple
name: Simple
questions:
  urgent:
    type: noul
    instructions: Is it urgent?
"""


@pytest.fixture
def store(tmp_path: Path) -> RecipeStore:
    return RecipeStore(tmp_path / "recipes")


def simple(**changes: object) -> Recipe:
    return parse_recipe_text(SIMPLE).model_copy(update=changes)


def test_create_get_list_export_delete(store: RecipeStore) -> None:
    r = store.create(simple())
    assert store.get("simple") == r
    listing = store.list_recipes()
    assert [s.id for s in listing.recipes] == ["simple"]
    assert listing.recipes[0].question_count == 1
    assert listing.recipes[0].example is False
    assert parse_recipe_text(store.export("simple")) == r
    store.delete("simple")
    assert not store.exists("simple")
    with pytest.raises(AppError) as info:
        store.get("simple")
    assert info.value.code is ErrorCode.RECIPE_NOT_FOUND


def test_create_refuses_existing(store: RecipeStore) -> None:
    store.create(simple())
    with pytest.raises(AppError) as info:
        store.create(simple(name="Other"))
    assert info.value.code is ErrorCode.RECIPE_EXISTS
    assert store.get("simple").name == "Simple"


def test_update_requires_existing_and_matching_id(store: RecipeStore) -> None:
    with pytest.raises(AppError) as info:
        store.update("simple", simple())
    assert info.value.code is ErrorCode.RECIPE_NOT_FOUND
    store.create(simple())
    store.update("simple", simple(name="Renamed"))
    assert store.get("simple").name == "Renamed"
    with pytest.raises(AppError) as info:
        store.update("simple", simple(id="other"))
    assert info.value.code is ErrorCode.INVALID_RECIPE


def test_delete_missing(store: RecipeStore) -> None:
    with pytest.raises(AppError) as info:
        store.delete("nope")
    assert info.value.code is ErrorCode.RECIPE_NOT_FOUND


def test_import_yaml(store: RecipeStore) -> None:
    store.import_yaml(SIMPLE)
    with pytest.raises(AppError):
        store.import_yaml(SIMPLE)
    store.import_yaml(SIMPLE.replace("name: Simple", "name: New"), overwrite=True)
    assert store.get("simple").name == "New"


def test_import_rejects_bad_yaml_and_bad_recipes(store: RecipeStore) -> None:
    with pytest.raises(AppError) as info:
        store.import_yaml("a: &x 1\nb: *x\n")
    assert info.value.issues[0].location == "yaml"
    with pytest.raises(AppError) as info:
        store.import_yaml(SIMPLE.replace("id: simple", "id: Bad"))
    assert info.value.code is ErrorCode.INVALID_RECIPE
    assert list(store.root.glob("*.yaml")) == []


@pytest.mark.parametrize(
    "malicious",
    [
        "../escape",
        "..",
        "a/b",
        "a\\b",
        "C:\\Windows\\win",
        "/etc/passwd",
        "con",
        "UPPER",
        "x" * 65,
        "",
        "simple.yaml",
        "simple\x00",
        "simple\n",
        "%2e%2e",
    ],
)
def test_malicious_ids_cannot_escape(store: RecipeStore, malicious: str, tmp_path: Path) -> None:
    for op in (store.get, store.delete, store.export):
        with pytest.raises(AppError):
            op(malicious)
    assert not store.exists(malicious)
    # Nothing was created anywhere, let alone outside the recipe directory.
    assert {p.name for p in tmp_path.iterdir()} <= {"recipes"}


def test_windows_reserved_names_stay_inside(store: RecipeStore) -> None:
    # "con" is a valid id; on Windows the store must still only touch con.yaml in root.
    store.create(simple(id="con"))
    assert store.get("con").id == "con"
    assert (store.root / "con.yaml").exists()


def _symlink(link: Path, target: Path) -> None:
    try:
        link.symlink_to(target)
    except OSError as exc:  # unprivileged Windows
        pytest.skip(f"symlinks unavailable: {exc}")


def test_symlinked_recipe_file_is_refused(store: RecipeStore, tmp_path: Path) -> None:
    outside = tmp_path / "outside.yaml"
    outside.write_text(SIMPLE.replace("id: simple", "id: linked"), encoding="utf-8")
    store.root.mkdir(parents=True)
    _symlink(store.root / "linked.yaml", outside)
    with pytest.raises(AppError):
        store.get("linked")
    with pytest.raises(AppError):
        store.save(simple(id="linked"))
    assert store.list_recipes().recipes == []
    assert "id: linked" in outside.read_text(encoding="utf-8")


def test_symlinked_root_is_refused(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    _symlink(link, real)
    with pytest.raises(AppError):
        RecipeStore(link).create(simple())
    assert list(real.iterdir()) == []


def test_reparse_point_detection(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    target = tmp_path / "x.yaml"
    target.write_text("x", encoding="utf-8")

    class FakeStat:
        st_mode = 0o100644
        st_file_attributes = 0x400

    monkeypatch.setattr(Path, "lstat", lambda self: FakeStat())  # type: ignore[misc]
    assert store_module._is_link(target)


def test_mismatched_file_name_is_invalid(store: RecipeStore) -> None:
    store.root.mkdir(parents=True)
    (store.root / "other.yaml").write_text(SIMPLE, encoding="utf-8")
    with pytest.raises(AppError) as info:
        store.get("other")
    assert info.value.code is ErrorCode.INVALID_RECIPE
    listing = store.list_recipes()
    assert listing.recipes == [] and [i.id for i in listing.invalid] == ["other"]


def test_listing_skips_temp_and_foreign_files(store: RecipeStore) -> None:
    store.create(simple())
    (store.root / ".simple.abc.tmp").write_text("partial", encoding="utf-8")
    (store.root / "Not_An_Id.yaml").write_text(SIMPLE, encoding="utf-8")
    (store.root / "notes.txt").write_text("x", encoding="utf-8")
    listing = store.list_recipes()
    assert [s.id for s in listing.recipes] == ["simple"] and listing.invalid == []


def test_corrupt_file_listed_as_invalid_not_fatal(store: RecipeStore) -> None:
    store.create(simple())
    (store.root / "broken.yaml").write_text("id: [unclosed", encoding="utf-8")
    listing = store.list_recipes()
    assert [s.id for s in listing.recipes] == ["simple"]
    assert [i.id for i in listing.invalid] == ["broken"]


def test_interrupted_write_keeps_previous_version(
    store: RecipeStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    store.create(simple())

    def boom(src: object, dst: object) -> None:
        raise OSError("disk yanked")

    monkeypatch.setattr(store_module.os, "replace", boom)
    with pytest.raises(OSError):
        store.update("simple", simple(name="Half written"))
    monkeypatch.undo()
    assert store.get("simple").name == "Simple"
    assert [p.name for p in store.root.iterdir()] == ["simple.yaml"]


def test_crash_during_fsync_leaves_no_valid_partial(
    store: RecipeStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    def crash(fd: int) -> None:
        raise KeyboardInterrupt

    monkeypatch.setattr(store_module.os, "fsync", crash)
    with pytest.raises(KeyboardInterrupt):
        store.create(simple())
    monkeypatch.undo()
    assert not store.exists("simple")
    assert list(store.root.iterdir()) == []


def test_concurrent_writers_leave_one_complete_version(store: RecipeStore) -> None:
    store.create(simple())
    names = [f"Writer {i}" for i in range(16)]
    threads = [
        threading.Thread(target=store.update, args=("simple", simple(name=n))) for n in names
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert store.get("simple").name in names
    assert [p.name for p in store.root.iterdir()] == ["simple.yaml"]


def test_round_trip_preserves_schema(store: RecipeStore) -> None:
    for text in bundled_examples():
        r = parse_recipe_text(text)
        store.save(r)
        assert store.get(r.id) == r
        assert parse_recipe_text(to_yaml(r)) == r
        # Unset per-question overrides are not written out as nulls.
        assert "null" not in to_yaml(r)


def test_seed_examples_first_run_only(store: RecipeStore) -> None:
    added = store.seed_examples()
    assert sorted(added) == [
        "document-review",
        "email-triage",
        "sales-lead-categorization",
        "support-routing",
    ]
    assert all(s.example for s in store.list_recipes().recipes)
    assert store.seed_examples() == []


def test_seed_never_overwrites_edits_or_restores_deletions(store: RecipeStore) -> None:
    store.seed_examples()
    edited = store.get("email-triage").model_copy(update={"name": "Mine"})
    store.update("email-triage", edited)
    store.delete("support-routing")
    assert store.seed_examples() == []
    assert store.get("email-triage").name == "Mine"
    assert not store.exists("support-routing")


def test_seed_does_not_overwrite_preexisting_user_recipe(store: RecipeStore) -> None:
    mine = simple(id="email-triage", name="User's own")
    store.create(mine)
    added = store.seed_examples()
    assert "email-triage" not in added
    assert store.get("email-triage").name == "User's own"
    assert "email-triage" in (store.root / SEED_MARKER).read_text(encoding="utf-8")


def test_examples_are_labelled_demonstrations() -> None:
    for text in bundled_examples():
        r = parse_recipe_text(text)
        assert r.description.startswith("Demonstration recipe, not a production-validated policy.")
        assert r.name.endswith("(example)")


def test_written_files_are_utf8_yaml(store: RecipeStore) -> None:
    store.create(simple(name="Tärkeä"))
    raw = (store.root / "simple.yaml").read_bytes()
    assert "Tärkeä".encode() in raw
