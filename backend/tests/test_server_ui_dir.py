from pathlib import Path

import pytest

from openreflex.lifecycle import server


def test_frozen_install_uses_only_the_packaged_ui(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    exe = tmp_path / "openreflex-service.exe"
    monkeypatch.setattr(server.sys, "frozen", True, raising=False)
    monkeypatch.setattr(server.sys, "executable", str(exe))
    assert server.ui_dir() is None
    (tmp_path / "ui").mkdir()
    (tmp_path / "ui" / "index.html").write_text("<!doctype html>", encoding="utf-8")
    assert server.ui_dir() == tmp_path / "ui"


def test_frozen_install_at_a_shallow_path_does_not_fail(monkeypatch: pytest.MonkeyPatch) -> None:
    anchor = Path.cwd().anchor or "/"
    monkeypatch.setattr(server.sys, "frozen", True, raising=False)
    monkeypatch.setattr(server.sys, "executable", str(Path(anchor) / "openreflex-service.exe"))
    assert server.ui_dir() is None or server.ui_dir() == Path(anchor) / "ui"
