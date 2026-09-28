from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "windows"))

import build
import smoke


def _payload(root: Path) -> Path:
    for name in (*build.NOTICES, "ui/index.html"):
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text("x", encoding="utf-8")
    return root


def test_complete_payload_passes(tmp_path: Path) -> None:
    build.check_payload(_payload(tmp_path))


def test_payload_with_model_weights_fails(tmp_path: Path) -> None:
    app = _payload(tmp_path)
    (app / "_internal" / "model.safetensors").parent.mkdir()
    (app / "_internal" / "model.safetensors").write_bytes(b"w")
    with pytest.raises(SystemExit, match="weights"):
        build.check_payload(app)


def test_payload_without_ui_or_notices_fails(tmp_path: Path) -> None:
    app = _payload(tmp_path)
    (app / "ui" / "index.html").unlink()
    (app / "LICENSE").unlink()
    with pytest.raises(SystemExit, match="missing"):
        build.check_payload(app)


def test_config_must_reference_the_packaged_mcp(tmp_path: Path) -> None:
    mcp = tmp_path / "Program Files" / "OpenReflex" / "openreflex-mcp.exe"
    smoke.check_config_references({"servers": {"x": {"command": str(mcp)}}}, mcp, "t")
    venv = tmp_path / ".venv" / "Scripts" / "openreflex-mcp.exe"
    with pytest.raises(SystemExit, match="does not reference"):
        smoke.check_config_references({"command": str(venv)}, mcp, "t")
    with pytest.raises(SystemExit, match="does not reference"):
        smoke.check_config_references({"command": "python"}, mcp, "t")
