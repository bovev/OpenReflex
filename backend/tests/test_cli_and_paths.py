from __future__ import annotations

import json
from pathlib import Path

import pytest

from openreflex import __version__, cli, paths
from openreflex.identity import APP_DATA_DIR_NAME


def test_data_dir_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(paths.DATA_DIR_ENV, str(tmp_path / "x"))
    assert paths.data_dir() == (tmp_path / "x").resolve()


def test_data_dir_windows_uses_localappdata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(paths.DATA_DIR_ENV, raising=False)
    monkeypatch.setattr(paths.sys, "platform", "win32")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    assert paths.data_dir() == tmp_path / APP_DATA_DIR_NAME


def test_data_dir_posix_uses_xdg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(paths.DATA_DIR_ENV, raising=False)
    monkeypatch.setattr(paths.sys, "platform", "linux")
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    assert paths.data_dir() == tmp_path / APP_DATA_DIR_NAME


def test_install_dir_frozen(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(paths.sys, "frozen", True, raising=False)
    monkeypatch.setattr(paths.sys, "executable", str(tmp_path / "app.exe"))
    assert paths.install_dir() == tmp_path.resolve()


def test_install_dir_source() -> None:
    assert (paths.install_dir() / "identity.py").is_file()


def test_version_command(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["version"]) == 0
    assert capsys.readouterr().out.strip() == __version__


def test_smoke_writes_only_to_data_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv(paths.DATA_DIR_ENV, str(tmp_path / "data"))
    assert cli.main(["smoke"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["data_dir_writable"] is True
    assert report["frozen"] is False
    assert list((tmp_path / "data").iterdir()) == []
