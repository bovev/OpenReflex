"""Download, verify, locate, and remove pinned model checkpoints.

Layout under ``<data>/models``::

    <profile>/<revision>/<file>          verified files
    <profile>/<revision>/<file>.part     partial download (resumable)
    <profile>/installed.json             written last, after every file verified
    <profile>/damaged                    set when a full verification fails
    <profile>.lock                       held while downloading or removing

Downloads only happen on explicit request, fetch only the files the catalog
lists, and verify every file against the pinned hash before it's used. A
profile counts as installed only once ``installed.json`` exists. That file is
written atomically after all files pass, so an interrupted download never
looks installed.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import os
import shutil
import threading
from collections.abc import Callable, Generator
from enum import StrEnum
from pathlib import Path
from typing import Final

from pydantic import BaseModel, ConfigDict, ValidationError

from openreflex.domain.errors import AppError, ErrorCode
from openreflex.domain.recipe import ModelProfile
from openreflex.models.catalog import AUTO_CANDIDATES, CATALOG, Checkpoint, ModelFile
from openreflex.models.locking import FileLock, LockHeld
from openreflex.models.source import ArtifactSource, SourceError
from openreflex.models.types import InstalledModel

MANIFEST: Final = "installed.json"
DAMAGED: Final = "damaged"
PART: Final = ".part"
_HASH_CHUNK: Final = 1 << 20


class _Oversize(Exception):
    pass


class ModelState(StrEnum):
    NOT_INSTALLED = "not_installed"
    DOWNLOADING = "downloading"
    INSTALLED = "installed"
    DAMAGED = "damaged"


class Manifest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    profile: ModelProfile
    repo_id: str
    revision: str
    verified_at: str
    bytes: int


class Progress(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    done_bytes: int
    total_bytes: int
    current_file: str | None = None


class ModelStatus(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    profile: ModelProfile
    checkpoint: str
    revision: str
    state: ModelState
    download_bytes: int
    disk_bytes: int
    verified_at: str | None = None
    progress: Progress | None = None
    last_error: str | None = None


def file_digest(path: Path, spec: ModelFile) -> bool:
    """True when ``path`` matches the catalog's size and hash."""
    try:
        if path.stat().st_size != spec.size:
            return False
    except FileNotFoundError:
        return False
    if spec.sha256:
        h = hashlib.sha256()
        expected = spec.sha256
    elif spec.git_blob_sha1:
        h = hashlib.sha1(usedforsecurity=False)  # git's content addressing, from pinned metadata
        h.update(b"blob %d\0" % spec.size)
        expected = spec.git_blob_sha1
    else:  # pragma: no cover - the catalog always records one
        return False
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(_HASH_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest() == expected


def _now() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat()


def _write_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _dir_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


ProgressCallback = Callable[[Progress], None]


class ModelManager:
    def __init__(
        self,
        root: Path,
        source: ArtifactSource,
        catalog: dict[ModelProfile, Checkpoint] | None = None,
    ) -> None:
        self._root = root
        self._source = source
        self._catalog = catalog or CATALOG
        self._progress: dict[ModelProfile, Progress] = {}
        self._errors: dict[ModelProfile, str] = {}
        self._mutex = threading.Lock()

    # -- paths ---------------------------------------------------------------

    def checkpoint(self, profile: ModelProfile) -> Checkpoint:
        try:
            return self._catalog[profile]
        except KeyError as exc:
            raise AppError(ErrorCode.MODEL_NOT_FOUND, f"no model profile '{profile}'") from exc

    def _profile_dir(self, profile: ModelProfile) -> Path:
        return self._root / profile.value

    def _files_dir(self, cp: Checkpoint) -> Path:
        return self._profile_dir(cp.profile) / cp.revision

    def _lock(self, profile: ModelProfile) -> FileLock:
        return FileLock(self._root / f"{profile.value}.lock")

    def _manifest(self, profile: ModelProfile) -> Manifest | None:
        path = self._profile_dir(profile) / MANIFEST
        try:
            return Manifest.model_validate_json(path.read_bytes())
        except (FileNotFoundError, ValidationError, ValueError):
            return None

    # -- queries -------------------------------------------------------------

    def _installed_ok(self, cp: Checkpoint, manifest: Manifest | None) -> bool:
        """Cheap check: manifest matches the pin and every file has its pinned size."""
        if manifest is None or manifest.revision != cp.revision or manifest.repo_id != cp.repo_id:
            return False
        base = self._files_dir(cp)
        for spec in cp.files:
            path = base / spec.path
            try:
                if path.stat().st_size != spec.size and spec.path not in cp.mutable_files:
                    return False
            except FileNotFoundError:
                return False
        return True

    def status(self, profile: ModelProfile) -> ModelStatus:
        cp = self.checkpoint(profile)
        manifest = self._manifest(profile)
        with self._mutex:
            progress = self._progress.get(profile)
            error = self._errors.get(profile)
        damaged = (self._profile_dir(profile) / DAMAGED).exists()
        if progress is not None:
            state = ModelState.DOWNLOADING
        elif damaged:
            state = ModelState.DAMAGED
        elif self._installed_ok(cp, manifest):
            state = ModelState.INSTALLED
        elif manifest is not None:
            state = ModelState.DAMAGED
        else:
            state = ModelState.NOT_INSTALLED
        return ModelStatus(
            profile=profile,
            checkpoint=cp.checkpoint_id,
            revision=cp.revision,
            state=state,
            download_bytes=cp.download_bytes,
            disk_bytes=_dir_bytes(self._profile_dir(profile)),
            verified_at=manifest.verified_at if manifest else None,
            progress=progress,
            last_error=error,
        )

    def statuses(self) -> list[ModelStatus]:
        return [self.status(p) for p in self._catalog]

    def is_ready(self, profile: ModelProfile) -> bool:
        profiles = AUTO_CANDIDATES if profile is ModelProfile.AUTO else (profile,)
        return all(self.status(p).state is ModelState.INSTALLED for p in profiles)

    def locate(self, profile: ModelProfile) -> InstalledModel:
        cp = self.checkpoint(profile)
        damaged = (self._profile_dir(profile) / DAMAGED).exists()
        if damaged or not self._installed_ok(cp, self._manifest(profile)):
            raise AppError(
                ErrorCode.MODEL_NOT_READY, f"model '{profile.value}' is not installed or incomplete"
            )
        return InstalledModel(checkpoint=cp, path=self._files_dir(cp))

    # -- download ------------------------------------------------------------

    def _set_progress(self, profile: ModelProfile, progress: Progress | None) -> None:
        with self._mutex:
            if progress is None:
                self._progress.pop(profile, None)
            else:
                self._progress[profile] = progress

    def download(
        self,
        profile: ModelProfile,
        *,
        cancel: threading.Event | None = None,
        on_progress: ProgressCallback | None = None,
    ) -> ModelStatus:
        """Blocking. Resumes partial files. Safe to call again after any failure."""
        cp = self.checkpoint(profile)
        lock = self._lock(profile)
        try:
            lock.acquire()
        except LockHeld as exc:
            raise AppError(ErrorCode.MODEL_BUSY, "this model is already being changed") from exc
        try:
            with self._mutex:
                self._errors.pop(profile, None)
            self._download_locked(cp, cancel, on_progress)
        except AppError as exc:
            with self._mutex:
                self._errors[profile] = exc.message
            raise
        finally:
            self._set_progress(profile, None)
            lock.release()
        return self.status(profile)

    def _download_locked(
        self,
        cp: Checkpoint,
        cancel: threading.Event | None,
        on_progress: ProgressCallback | None,
    ) -> None:
        base = self._files_dir(cp)
        base.mkdir(parents=True, exist_ok=True)
        manifest_path = self._profile_dir(cp.profile) / MANIFEST
        manifest_path.unlink(missing_ok=True)  # not installed until everything verifies
        total = cp.download_bytes
        done = 0

        def report(current: str | None) -> None:
            progress = Progress(done_bytes=done, total_bytes=total, current_file=current)
            self._set_progress(cp.profile, progress)
            if on_progress:
                on_progress(progress)

        report(None)
        for spec in cp.files:
            final = base / spec.path
            if file_digest(final, spec):
                done += spec.size
                report(spec.path)
                continue
            final.unlink(missing_ok=True)
            part = final.with_name(final.name + PART)
            part.parent.mkdir(parents=True, exist_ok=True)
            offset = part.stat().st_size if part.exists() else 0
            if offset > spec.size:
                part.unlink()
                offset = 0
            done += offset
            try:
                with part.open("ab") as out:
                    for chunk in self._source.fetch(
                        cp.repo_id, cp.revision, cp.repo_path(spec), offset
                    ):
                        if cancel is not None and cancel.is_set():
                            raise AppError(ErrorCode.DOWNLOAD_FAILED, "download was cancelled")
                        offset += len(chunk)
                        if offset > spec.size:
                            raise _Oversize
                        out.write(chunk)
                        done += len(chunk)
                        report(spec.path)
                    out.flush()
                    os.fsync(out.fileno())
            except SourceError as exc:
                raise AppError(ErrorCode.DOWNLOAD_FAILED, str(exc)) from exc
            except _Oversize as exc:
                part.unlink(missing_ok=True)
                raise AppError(
                    ErrorCode.DOWNLOAD_FAILED, f"{spec.path} is larger than expected"
                ) from exc
            if not file_digest(part, spec):
                part.unlink(missing_ok=True)
                raise AppError(
                    ErrorCode.DOWNLOAD_FAILED,
                    f"{spec.path} failed verification and was discarded; try again",
                )
            os.replace(part, final)

        manifest = Manifest(
            profile=cp.profile,
            repo_id=cp.repo_id,
            revision=cp.revision,
            verified_at=_now(),
            bytes=cp.download_bytes,
        )
        _write_atomic(manifest_path, manifest.model_dump_json(indent=2))
        (self._profile_dir(cp.profile) / DAMAGED).unlink(missing_ok=True)

    # -- verify / remove -----------------------------------------------------

    def verify(self, profile: ModelProfile) -> ModelStatus:
        """Full re-hash of every file. Marks the profile damaged on any mismatch."""
        cp = self.checkpoint(profile)
        with self._busy(profile):
            manifest = self._manifest(profile)
            if manifest is None:
                raise AppError(
                    ErrorCode.MODEL_NOT_READY, f"model '{profile.value}' is not installed"
                )
            base = self._files_dir(cp)
            ok = all(
                (
                    (base / s.path).is_file()
                    if s.path in cp.mutable_files
                    else file_digest(base / s.path, s)
                )
                for s in cp.files
            )
            marker = self._profile_dir(profile) / DAMAGED
            if not ok:
                marker.touch()
                raise AppError(
                    ErrorCode.MODEL_NOT_READY,
                    f"model '{profile.value}' failed verification; download it again",
                )
            marker.unlink(missing_ok=True)
            fresh = manifest.model_copy(update={"verified_at": _now()})
            _write_atomic(self._profile_dir(profile) / MANIFEST, fresh.model_dump_json(indent=2))
        return self.status(profile)

    def remove(self, profile: ModelProfile) -> ModelStatus:
        """Delete the local files. The caller must unload the engine first."""
        with self._busy(profile):
            target = self._profile_dir(profile)
            if target.exists():
                shutil.rmtree(target)
        with self._mutex:
            self._errors.pop(profile, None)
        return self.status(profile)

    @contextlib.contextmanager
    def _busy(self, profile: ModelProfile) -> Generator[None]:
        self.checkpoint(profile)
        lock = self._lock(profile)
        try:
            lock.acquire()
        except LockHeld as exc:
            raise AppError(
                ErrorCode.MODEL_BUSY, "this model is being downloaded or changed"
            ) from exc
        try:
            yield
        finally:
            lock.release()
