"""One-YAML-file-per-recipe storage under the application data directory.

Callers never supply paths. A recipe id is validated against the strict id
pattern first and then mapped to ``<root>/<id>.yaml``. Symlinks and other
reparse points are refused, both for the root and for recipe files. Writes
are atomic: they go to a temporary file in the same directory, are fsynced,
and replace the target in one step, so an interrupted write never leaves a
partial file where a valid recipe is expected.
"""

from __future__ import annotations

import contextlib
import os
import re
import stat
import tempfile
import threading
from collections.abc import Iterator
from importlib import resources
from pathlib import Path
from typing import Final

from pydantic import BaseModel, ConfigDict

from openreflex.domain.errors import AppError, ErrorCode, Issue
from openreflex.domain.recipe import MAX_ID_LENGTH, RECIPE_ID_PATTERN, ModelProfile, Recipe
from openreflex.domain.validation import parse_recipe
from openreflex.recipes.yaml_io import RecipeYamlError, dump_recipe_yaml, load_recipe_yaml

SUFFIX: Final = ".yaml"
SEED_MARKER: Final = ".examples-seeded"
_ID_RE: Final = re.compile(RECIPE_ID_PATTERN)
_REPARSE_POINT: Final = 0x400  # FILE_ATTRIBUTE_REPARSE_POINT


class RecipeSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    name: str
    description: str
    model_profile: ModelProfile
    question_count: int
    example: bool


class InvalidRecipeFile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    issues: list[Issue]


class RecipeListing(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    recipes: list[RecipeSummary]
    invalid: list[InvalidRecipeFile]


def _is_link(path: Path) -> bool:
    try:
        st = path.lstat()
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(st.st_mode):
        return True
    return bool(getattr(st, "st_file_attributes", 0) & _REPARSE_POINT)


def parse_recipe_text(text: str | bytes) -> Recipe:
    try:
        data = load_recipe_yaml(text)
    except RecipeYamlError as exc:
        raise AppError(
            ErrorCode.INVALID_RECIPE,
            "recipe is invalid",
            [Issue(location="yaml", message=str(exc))],
        ) from exc
    return parse_recipe(data)


def to_yaml(recipe: Recipe) -> str:
    return dump_recipe_yaml(recipe.model_dump(mode="json", exclude_none=True))


class RecipeStore:
    def __init__(self, root: Path) -> None:
        self._root = root
        self._lock = threading.RLock()

    @property
    def root(self) -> Path:
        return self._root

    # -- paths ---------------------------------------------------------------

    def _ensure_root(self) -> Path:
        if _is_link(self._root):
            raise AppError(ErrorCode.INTERNAL, "recipe directory must not be a link")
        self._root.mkdir(parents=True, exist_ok=True)
        return self._root

    def _path(self, recipe_id: str) -> Path:
        # fullmatch: `$` in the pattern would otherwise accept a trailing newline.
        if len(recipe_id) > MAX_ID_LENGTH or not _ID_RE.fullmatch(recipe_id):
            raise AppError(ErrorCode.RECIPE_NOT_FOUND, "no recipe with that id")
        root = self._ensure_root()
        path = root / f"{recipe_id}{SUFFIX}"
        if path.parent != root or _is_link(path):
            raise AppError(ErrorCode.RECIPE_NOT_FOUND, "no recipe with that id")
        return path

    # -- reads ---------------------------------------------------------------

    def _read(self, path: Path) -> Recipe:
        try:
            raw = path.read_bytes()
        except FileNotFoundError as exc:
            raise AppError(ErrorCode.RECIPE_NOT_FOUND, "no recipe with that id") from exc
        recipe = parse_recipe_text(raw)
        if recipe.id != path.stem:
            raise AppError(
                ErrorCode.INVALID_RECIPE,
                "recipe is invalid",
                [Issue(location="id", message="id does not match the file name")],
            )
        return recipe

    def get(self, recipe_id: str) -> Recipe:
        with self._lock:
            return self._read(self._path(recipe_id))

    def exists(self, recipe_id: str) -> bool:
        try:
            return self._path(recipe_id).is_file()
        except AppError:
            return False

    def export(self, recipe_id: str) -> str:
        return to_yaml(self.get(recipe_id))

    def list_recipes(self) -> RecipeListing:
        with self._lock:
            root = self._ensure_root()
            examples = self._seeded_ids()
            recipes: list[RecipeSummary] = []
            invalid: list[InvalidRecipeFile] = []
            for path in sorted(root.glob(f"*{SUFFIX}")):
                stem = path.stem
                if not _ID_RE.fullmatch(stem) or _is_link(path) or not path.is_file():
                    continue
                try:
                    r = self._read(path)
                except AppError as exc:
                    invalid.append(InvalidRecipeFile(id=stem, issues=exc.issues))
                    continue
                recipes.append(
                    RecipeSummary(
                        id=r.id,
                        name=r.name,
                        description=r.description,
                        model_profile=r.model_profile,
                        question_count=len(r.questions),
                        example=r.id in examples,
                    )
                )
            return RecipeListing(recipes=recipes, invalid=invalid)

    # -- writes --------------------------------------------------------------

    def _write(self, path: Path, recipe: Recipe) -> None:
        data = to_yaml(recipe).encode("utf-8")
        fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.stem}.", suffix=".tmp")
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        except BaseException:
            with contextlib.suppress(FileNotFoundError):
                tmp.unlink()
            raise
        _fsync_dir(path.parent)

    def create(self, recipe: Recipe) -> Recipe:
        with self._lock:
            path = self._path(recipe.id)
            if path.exists():
                raise AppError(ErrorCode.RECIPE_EXISTS, "a recipe with that id already exists")
            self._write(path, recipe)
            return recipe

    def update(self, recipe_id: str, recipe: Recipe) -> Recipe:
        with self._lock:
            if recipe.id != recipe_id:
                raise AppError(
                    ErrorCode.INVALID_RECIPE,
                    "recipe is invalid",
                    [Issue(location="id", message="id cannot be changed by an update")],
                )
            path = self._path(recipe_id)
            if not path.is_file():
                raise AppError(ErrorCode.RECIPE_NOT_FOUND, "no recipe with that id")
            self._write(path, recipe)
            return recipe

    def save(self, recipe: Recipe) -> Recipe:
        """Create or replace."""
        with self._lock:
            self._write(self._path(recipe.id), recipe)
            return recipe

    def delete(self, recipe_id: str) -> None:
        with self._lock:
            path = self._path(recipe_id)
            try:
                path.unlink()
            except FileNotFoundError as exc:
                raise AppError(ErrorCode.RECIPE_NOT_FOUND, "no recipe with that id") from exc

    def import_yaml(self, text: str | bytes, *, overwrite: bool = False) -> Recipe:
        recipe = parse_recipe_text(text)
        return self.save(recipe) if overwrite else self.create(recipe)

    # -- examples ------------------------------------------------------------

    def _seeded_ids(self) -> set[str]:
        marker = self._root / SEED_MARKER
        try:
            return {line.strip() for line in marker.read_text(encoding="utf-8").splitlines()} - {""}
        except FileNotFoundError:
            return set()

    def seed_examples(self) -> list[str]:
        """Copy bundled examples on first run. Never overwrites or re-adds.

        The marker records which examples were offered, so an example the user
        edited is left alone and one the user deleted is not brought back.
        """
        with self._lock:
            root = self._ensure_root()
            marker = root / SEED_MARKER
            offered = self._seeded_ids()
            added: list[str] = []
            for text in bundled_examples():
                recipe = parse_recipe_text(text)
                if recipe.id in offered:
                    continue
                offered.add(recipe.id)
                path = self._path(recipe.id)
                if not path.exists():
                    self._write(path, recipe)
                    added.append(recipe.id)
            if not _is_link(marker):
                marker.write_text("\n".join(sorted(offered)) + "\n", encoding="utf-8")
            return added


def bundled_examples() -> Iterator[str]:
    folder = resources.files("openreflex.recipes") / "examples"
    for entry in sorted(folder.iterdir(), key=lambda e: e.name):
        if entry.name.endswith(SUFFIX):
            yield entry.read_text(encoding="utf-8")


def _fsync_dir(path: Path) -> None:
    if os.name == "nt":  # directories can't be opened for fsync on Windows
        return
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
