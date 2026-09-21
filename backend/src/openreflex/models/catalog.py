"""Pinned model checkpoints: repository, immutable revision, and per-file hashes.

Values come from the hub's metadata for the pinned revision (see
docs/architecture/laya-compatibility.md). Large files are verified by their
LFS sha256. Small files are verified by their git blob SHA-1, which the hub
also records at the revision. Only files listed here are ever downloaded.
Notably, that excludes the Python files the repository also contains.
"""

from __future__ import annotations

from typing import Final

from pydantic import BaseModel, ConfigDict

from openreflex.domain.recipe import ModelProfile

REPO_ID: Final = "convaiinnovations/laya"
REVISION: Final = "1c5edc17a7acd8701df6fc341c0d179f1c62c982"


class ModelFile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    path: str  # relative to the checkpoint directory
    size: int
    sha256: str | None = None  # LFS files
    git_blob_sha1: str | None = None  # regular files


class Checkpoint(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    profile: ModelProfile
    repo_id: str
    revision: str
    subfolder: str | None
    files: tuple[ModelFile, ...]
    max_len: int
    head_max_len: int
    # Laya rewrites this file in place on load (``_fix_tokenizer_config``).
    mutable_files: tuple[str, ...] = ("tokenizer/tokenizer_config.json",)

    @property
    def checkpoint_id(self) -> str:
        return f"{self.repo_id}/{self.subfolder}" if self.subfolder else self.repo_id

    @property
    def download_bytes(self) -> int:
        return sum(f.size for f in self.files)

    def repo_path(self, file: ModelFile) -> str:
        return f"{self.subfolder}/{file.path}" if self.subfolder else file.path


def _files(*rows: tuple[str, int, str | None, str | None]) -> tuple[ModelFile, ...]:
    return tuple(ModelFile(path=p, size=s, sha256=h, git_blob_sha1=b) for p, s, h, b in rows)


CATALOG: Final[dict[ModelProfile, Checkpoint]] = {
    ModelProfile.TYPED_DECISIONS: Checkpoint(
        profile=ModelProfile.TYPED_DECISIONS,
        repo_id=REPO_ID,
        revision=REVISION,
        subfolder="typed-decisions",
        max_len=1024,
        head_max_len=256,
        files=_files(
            ("rl_agent_config.json", 847, None, "5f0e1d5f2366fe8ba2ff330dffaeed53b469e97e"),
            ("encoder/config.json", 2084, None, "d4be4829750fb04c0aa8b9897c3ea827f76c0109"),
            ("tokenizer/tokenizer.json", 3583228, None, "2f4d8583e507b7466d2490e2d6c045647a822698"),
            (
                "tokenizer/tokenizer_config.json",
                337,
                None,
                "ed1ffabc2ce11120754705709569e365e46da71a",
            ),
            (
                "model.safetensors",
                842609220,
                "4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e",
                None,
            ),
        ),
    ),
    ModelProfile.ENGLISH: Checkpoint(
        profile=ModelProfile.ENGLISH,
        repo_id=REPO_ID,
        revision=REVISION,
        subfolder=None,
        max_len=512,
        head_max_len=192,
        files=_files(
            ("rl_agent_config.json", 745, None, "3e4fcbf12cf36164ce18a1398aa9f35f58375ae0"),
            ("encoder/config.json", 2083, None, "5881ba831f2db5ce0f606bbaa1f2668e1e6cb706"),
            ("tokenizer/tokenizer.json", 3583228, None, "2f4d8583e507b7466d2490e2d6c045647a822698"),
            (
                "tokenizer/tokenizer_config.json",
                308,
                None,
                "9fd800115c5c92353220aa66addfce67a9135f32",
            ),
            (
                "model.safetensors",
                842609210,
                "891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c",
                None,
            ),
        ),
    ),
    ModelProfile.MULTILINGUAL: Checkpoint(
        profile=ModelProfile.MULTILINGUAL,
        repo_id=REPO_ID,
        revision=REVISION,
        subfolder="multilingual",
        max_len=1024,
        head_max_len=256,
        files=_files(
            ("rl_agent_config.json", 472, None, "00e35f88bb731bb9126a914666ab1cdac8a204c8"),
            ("encoder/config.json", 1938, None, "0de0e2d30638873790cf962def52e2acf4db3eef"),
            (
                "tokenizer/tokenizer.json",
                34363188,
                "609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f",
                None,
            ),
            (
                "tokenizer/tokenizer_config.json",
                524,
                None,
                "c255ac0c8cb34a37d066cd0dafe313fd769d27ae",
            ),
            (
                "model.safetensors",
                643835514,
                "9d628fd971b700382ac6f65920a86f149777b2e748e0c955fb3b19695aa8f204",
                None,
            ),
        ),
    ),
}

# `auto` is not a checkpoint: it routes between english and multilingual.
AUTO_CANDIDATES: Final = (ModelProfile.ENGLISH, ModelProfile.MULTILINGUAL)
