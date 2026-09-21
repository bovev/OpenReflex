"""Model manager tests with a fake catalog and in-memory source. No network."""

from __future__ import annotations

import hashlib
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from openreflex.domain.errors import AppError, ErrorCode
from openreflex.domain.recipe import ModelProfile
from openreflex.models import source as source_module
from openreflex.models.catalog import CATALOG, Checkpoint, ModelFile
from openreflex.models.locking import FileLock, LockHeld
from openreflex.models.manager import (
    DAMAGED,
    MANIFEST,
    ModelManager,
    ModelState,
    Progress,
    file_digest,
)
from openreflex.models.source import HubSource, SourceError

WEIGHTS = bytes(range(256)) * 400  # ~100 KiB "LFS" file
CONFIG = b'{"max_len": 1024}'
TOKCFG = b'{"tokenizer_class": "X"}'


def git_blob_sha1(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data, usedforsecurity=False).hexdigest()


FILES = {
    "rl_agent_config.json": CONFIG,
    "tokenizer/tokenizer_config.json": TOKCFG,
    "model.safetensors": WEIGHTS,
}


def make_catalog() -> dict[ModelProfile, Checkpoint]:
    files = (
        ModelFile(
            path="rl_agent_config.json", size=len(CONFIG), git_blob_sha1=git_blob_sha1(CONFIG)
        ),
        ModelFile(
            path="tokenizer/tokenizer_config.json",
            size=len(TOKCFG),
            git_blob_sha1=git_blob_sha1(TOKCFG),
        ),
        ModelFile(
            path="model.safetensors",
            size=len(WEIGHTS),
            sha256=hashlib.sha256(WEIGHTS).hexdigest(),
        ),
    )
    return {
        ModelProfile.TYPED_DECISIONS: Checkpoint(
            profile=ModelProfile.TYPED_DECISIONS,
            repo_id="org/repo",
            revision="a" * 40,
            subfolder="typed-decisions",
            files=files,
            max_len=1024,
            head_max_len=256,
        ),
        ModelProfile.ENGLISH: Checkpoint(
            profile=ModelProfile.ENGLISH,
            repo_id="org/repo",
            revision="a" * 40,
            subfolder=None,
            files=files,
            max_len=512,
            head_max_len=192,
        ),
    }


class FakeSource:
    def __init__(self, files: dict[str, bytes] | None = None, chunk: int = 4096) -> None:
        self.files = dict(files or FILES)
        self.chunk = chunk
        self.requests: list[tuple[str, str, str, int]] = []
        self.fail_after: int | None = None  # bytes delivered before an interruption

    def fetch(self, repo_id: str, revision: str, path: str, offset: int) -> Iterator[bytes]:
        self.requests.append((repo_id, revision, path, offset))
        name = path.split("/", 1)[1] if path.startswith("typed-decisions/") else path
        data = self.files[name][offset:]
        sent = 0
        for i in range(0, len(data), self.chunk):
            if self.fail_after is not None and sent >= self.fail_after:
                self.fail_after = None
                raise SourceError(f"download of {path} was interrupted")
            piece = data[i : i + self.chunk]
            sent += len(piece)
            yield piece


@pytest.fixture
def source() -> FakeSource:
    return FakeSource()


@pytest.fixture
def manager(tmp_path: Path, source: FakeSource) -> ModelManager:
    return ModelManager(tmp_path / "models", source, make_catalog())


TD = ModelProfile.TYPED_DECISIONS


def test_starts_not_installed(manager: ModelManager) -> None:
    status = manager.status(TD)
    assert status.state is ModelState.NOT_INSTALLED
    assert status.download_bytes == sum(len(v) for v in FILES.values())
    assert status.disk_bytes == 0
    with pytest.raises(AppError) as info:
        manager.locate(TD)
    assert info.value.code is ErrorCode.MODEL_NOT_READY
    assert not manager.is_ready(TD)


def test_download_verifies_and_installs(manager: ModelManager, source: FakeSource) -> None:
    seen: list[Progress] = []
    status = manager.download(TD, on_progress=seen.append)
    assert status.state is ModelState.INSTALLED
    assert status.verified_at and status.progress is None
    assert status.disk_bytes >= status.download_bytes
    installed = manager.locate(TD)
    assert (installed.path / "model.safetensors").read_bytes() == WEIGHTS
    assert installed.path.name == "a" * 40
    done = [p.done_bytes for p in seen]
    assert done == sorted(done) and done[-1] == status.download_bytes
    # Only the pinned files at the pinned revision, with subfolder prefix.
    assert {(r[1], r[2]) for r in source.requests} == {
        ("a" * 40, f"typed-decisions/{name}") for name in FILES
    }
    assert manager.is_ready(TD)


def test_second_download_reuses_verified_files(manager: ModelManager, source: FakeSource) -> None:
    manager.download(TD)
    source.requests.clear()
    manager.download(TD)
    assert source.requests == []


def test_interrupted_download_resumes(manager: ModelManager, source: FakeSource) -> None:
    source.fail_after = 40_000
    with pytest.raises(AppError) as info:
        manager.download(TD)
    assert info.value.code is ErrorCode.DOWNLOAD_FAILED
    status = manager.status(TD)
    assert status.state is ModelState.NOT_INSTALLED
    assert status.last_error and "interrupted" in status.last_error
    with pytest.raises(AppError):
        manager.locate(TD)
    source.requests.clear()
    assert manager.download(TD).state is ModelState.INSTALLED
    resumed = [r for r in source.requests if r[2].endswith("model.safetensors")]
    assert resumed and resumed[0][3] >= 40_000
    assert manager.status(TD).last_error is None


def test_corrupt_download_is_discarded(tmp_path: Path) -> None:
    bad = FakeSource({**FILES, "model.safetensors": b"\0" * len(WEIGHTS)})
    manager = ModelManager(tmp_path / "models", bad, make_catalog())
    with pytest.raises(AppError, match="failed verification"):
        manager.download(TD)
    parts = list((tmp_path / "models").rglob("*.part"))
    assert parts == []
    assert manager.status(TD).state is ModelState.NOT_INSTALLED


def test_oversized_download_is_discarded(tmp_path: Path) -> None:
    big = FakeSource({**FILES, "rl_agent_config.json": CONFIG + b"x" * 10_000})
    manager = ModelManager(tmp_path / "models", big, make_catalog())
    with pytest.raises(AppError, match="larger than expected"):
        manager.download(TD)
    assert list((tmp_path / "models").rglob("*.part")) == []


def test_oversized_partial_restarts(manager: ModelManager, tmp_path: Path) -> None:
    part = tmp_path / "models" / "typed-decisions" / ("a" * 40) / "model.safetensors.part"
    part.parent.mkdir(parents=True)
    part.write_bytes(b"x" * (len(WEIGHTS) + 5))
    assert manager.download(TD).state is ModelState.INSTALLED


def test_cancel(manager: ModelManager) -> None:
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(AppError, match="cancelled"):
        manager.download(TD, cancel=cancel)
    assert manager.status(TD).state is ModelState.NOT_INSTALLED


def test_concurrent_mutation_is_refused(manager: ModelManager, tmp_path: Path) -> None:
    with FileLock(tmp_path / "models" / "typed-decisions.lock"):
        for op in (manager.download, manager.remove, manager.verify):
            with pytest.raises(AppError) as info:
                op(TD)
            assert info.value.code is ErrorCode.MODEL_BUSY
    assert manager.download(TD).state is ModelState.INSTALLED


def test_status_reports_downloading(manager: ModelManager, source: FakeSource) -> None:
    states: list[ModelState] = []

    def watch(_: Progress) -> None:
        if not states:
            states.append(manager.status(TD).state)

    manager.download(TD, on_progress=watch)
    assert states == [ModelState.DOWNLOADING]


def test_verify_detects_tampering(manager: ModelManager) -> None:
    manager.download(TD)
    weights = manager.locate(TD).path / "model.safetensors"
    data = bytearray(weights.read_bytes())
    data[100] ^= 1
    weights.write_bytes(bytes(data))
    assert manager.status(TD).state is ModelState.INSTALLED  # cheap check: size unchanged
    with pytest.raises(AppError, match="failed verification"):
        manager.verify(TD)
    assert manager.status(TD).state is ModelState.DAMAGED
    with pytest.raises(AppError):
        manager.locate(TD)
    assert manager.download(TD).state is ModelState.INSTALLED
    assert not (weights.parents[1] / DAMAGED).exists()
    assert manager.verify(TD).state is ModelState.INSTALLED


def test_missing_file_is_damaged(manager: ModelManager) -> None:
    manager.download(TD)
    (manager.locate(TD).path / "rl_agent_config.json").unlink()
    assert manager.status(TD).state is ModelState.DAMAGED


def test_upstream_rewrite_of_mutable_file_is_tolerated(manager: ModelManager) -> None:
    manager.download(TD)
    path = manager.locate(TD).path / "tokenizer/tokenizer_config.json"
    path.write_bytes(b'{"tokenizer_class": "PreTrainedTokenizerFast", "rewritten": true}')
    assert manager.status(TD).state is ModelState.INSTALLED
    assert manager.verify(TD).state is ModelState.INSTALLED


def test_verify_not_installed(manager: ModelManager) -> None:
    with pytest.raises(AppError) as info:
        manager.verify(TD)
    assert info.value.code is ErrorCode.MODEL_NOT_READY


def test_manifest_for_other_revision_is_not_installed(manager: ModelManager) -> None:
    manager.download(TD)
    manifest = manager.locate(TD).path.parent / MANIFEST
    manifest.write_text(manifest.read_text().replace("a" * 40, "b" * 40), encoding="utf-8")
    assert manager.status(TD).state is ModelState.DAMAGED
    manifest.write_text("not json", encoding="utf-8")
    assert manager.status(TD).state is ModelState.NOT_INSTALLED


def test_remove(manager: ModelManager) -> None:
    manager.download(TD)
    status = manager.remove(TD)
    assert status.state is ModelState.NOT_INSTALLED and status.disk_bytes == 0
    assert manager.remove(TD).state is ModelState.NOT_INSTALLED  # idempotent


def test_unknown_profile(manager: ModelManager) -> None:
    with pytest.raises(AppError) as info:
        manager.status(ModelProfile.MULTILINGUAL)
    assert info.value.code is ErrorCode.MODEL_NOT_FOUND


def test_auto_readiness_needs_both_candidates(tmp_path: Path, source: FakeSource) -> None:
    catalog = make_catalog()
    catalog[ModelProfile.MULTILINGUAL] = catalog[ModelProfile.ENGLISH].model_copy(
        update={"profile": ModelProfile.MULTILINGUAL, "subfolder": None}
    )
    manager = ModelManager(tmp_path / "models", source, catalog)
    manager.download(ModelProfile.ENGLISH)
    assert not manager.is_ready(ModelProfile.AUTO)
    manager.download(ModelProfile.MULTILINGUAL)
    assert manager.is_ready(ModelProfile.AUTO)
    assert len(manager.statuses()) == 3


def test_git_blob_digest_matches_git() -> None:
    # `printf 'hello\n' | git hash-object --stdin`
    assert git_blob_sha1(b"hello\n") == "ce013625030ba8dba906f756967f9e9ca394464a"


def test_file_digest_checks_size_first(tmp_path: Path) -> None:
    path = tmp_path / "f"
    path.write_bytes(b"hello\n")
    spec = ModelFile(path="f", size=6, git_blob_sha1="ce013625030ba8dba906f756967f9e9ca394464a")
    assert file_digest(path, spec)
    assert not file_digest(path, spec.model_copy(update={"size": 7}))
    assert not file_digest(tmp_path / "missing", spec)


# -- real catalog ---------------------------------------------------------------


def test_real_catalog_is_pinned_and_code_free() -> None:
    for profile, cp in CATALOG.items():
        assert cp.profile is profile
        assert len(cp.revision) == 40
        assert all((f.sha256 is None) != (f.git_blob_sha1 is None) for f in cp.files)
        assert not any(f.path.endswith((".py", ".pyc", ".bin", ".pkl", ".pt")) for f in cp.files)
        assert {f.path for f in cp.files} >= {"rl_agent_config.json", "model.safetensors"}
    assert CATALOG[ModelProfile.TYPED_DECISIONS].download_bytes == 846_195_716
    assert CATALOG[ModelProfile.ENGLISH].checkpoint_id == "convaiinnovations/laya"


# -- locking ----------------------------------------------------------------------


def test_file_lock_is_exclusive(tmp_path: Path) -> None:
    a, b = FileLock(tmp_path / "x.lock"), FileLock(tmp_path / "x.lock")
    with a:
        assert a.held
        with pytest.raises(LockHeld):
            b.acquire()
        with pytest.raises(LockHeld):
            a.acquire()
    b.acquire()
    b.release()
    b.release()  # no-op


# -- hub source ---------------------------------------------------------------------


def test_hub_source_requires_https() -> None:
    with pytest.raises(ValueError):
        HubSource("http://huggingface.co")


def test_hub_source_url_is_exact_and_quoted() -> None:
    url = HubSource().url("org/repo", "abc", "sub dir/model.safetensors")
    assert url == "https://huggingface.co/org/repo/resolve/abc/sub%20dir/model.safetensors"


class FakeResponse:
    def __init__(self, status: int, url: str, body: bytes, fail: bool = False) -> None:
        self.status, self._url, self._body, self._fail = status, url, body, fail

    def geturl(self) -> str:
        return self._url

    def read(self, n: int) -> bytes:
        if self._fail:
            raise OSError("reset")
        out, self._body = self._body[:n], self._body[n:]
        return out

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_: object) -> None:
        return None


def _patch_urlopen(monkeypatch: pytest.MonkeyPatch, response: Any, seen: list[Any]) -> None:
    def urlopen(request: Any, timeout: float) -> Any:
        seen.append(request)
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(source_module.urllib.request, "urlopen", urlopen)


def test_hub_source_streams_and_resumes(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[Any] = []
    _patch_urlopen(monkeypatch, FakeResponse(206, "https://cdn.example/x", b"abc"), seen)
    assert b"".join(HubSource().fetch("o/r", "rev", "f", 10)) == b"abc"
    assert seen[0].get_header("Range") == "bytes=10-"


@pytest.mark.parametrize(
    ("response", "message"),
    [
        (FakeResponse(200, "https://cdn.example/x", b"abc"), "resuming"),
        (FakeResponse(206, "http://cdn.example/x", b"abc"), "non-HTTPS"),
        (FakeResponse(206, "https://cdn.example/x", b"abc", fail=True), "interrupted"),
        (OSError("dns"), "could not download"),
    ],
)
def test_hub_source_failures(monkeypatch: pytest.MonkeyPatch, response: Any, message: str) -> None:
    _patch_urlopen(monkeypatch, response, [])
    with pytest.raises(SourceError, match=message):
        b"".join(HubSource().fetch("o/r", "rev", "f", 5))


def test_file_lock_is_exclusive_across_processes(tmp_path: Path) -> None:
    import subprocess
    import sys

    lock_path = tmp_path / "p.lock"
    code = (
        "import sys; from pathlib import Path; from openreflex.models.locking import FileLock\n"
        f"lock = FileLock(Path({str(lock_path)!r})); lock.acquire()\n"
        "print('locked', flush=True); sys.stdin.read()\n"
    )
    child = subprocess.Popen(
        [sys.executable, "-c", code], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True
    )
    try:
        assert child.stdout is not None and child.stdout.readline().strip() == "locked"
        with pytest.raises(LockHeld):
            FileLock(lock_path).acquire()
    finally:
        assert child.stdin is not None
        child.stdin.close()
        child.wait(timeout=30)
    # The OS released the lock when the child exited.
    with FileLock(lock_path):
        pass
