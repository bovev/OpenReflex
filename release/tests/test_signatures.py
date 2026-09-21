from __future__ import annotations

import shutil
import struct
import sys
from collections.abc import Sequence
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "windows"))

import signatures
from signatures import Signature

VALID = Signature("Valid", "", "CN=Signer", True, False)
UNSIGNED = Signature("NotSigned", "not signed", None, False, False)


def _pe(path: Path) -> Path:
    header = bytearray(128)
    header[:2] = b"MZ"
    struct.pack_into("<I", header, 0x3C, 64)
    header[64:68] = b"PE\0\0"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(header))
    return path


def _fake(results: dict[str, Signature]) -> signatures.Verifier:
    def verify(paths: Sequence[Path]) -> dict[Path, Signature]:
        return {p: results[p.name] for p in paths if p.name in results}

    return verify


def test_detects_pe_by_header_not_extension(tmp_path: Path) -> None:
    _pe(tmp_path / "a.dll")
    _pe(tmp_path / "sub" / "hidden.bin")
    (tmp_path / "fake.exe").write_bytes(b"MZ" + b"\0" * 10)
    (tmp_path / "notes.txt").write_text("MZ but text")
    found = [p.relative_to(tmp_path).as_posix() for p in signatures.find_pe_files(tmp_path)]
    assert found == ["a.dll", "sub/hidden.bin"]


def test_every_pe_file_is_required(tmp_path: Path) -> None:
    for name in ("app.exe", "core.pyd", "driver.sys", "blob.bin"):
        _pe(tmp_path / name)
    entries = signatures.inventory(
        tmp_path,
        _fake({"app.exe": VALID, "core.pyd": UNSIGNED, "driver.sys": VALID}),
    )
    bad = {e.path: e.status for e in signatures.failures(entries)}
    # blob.bin has no verification result at all and must fail closed.
    assert bad == {"core.pyd": "NotSigned", "blob.bin": "Error"}
    listed = {e.path: e.extension_listed for e in entries}
    assert listed["blob.bin"] is False and listed["core.pyd"] is True


def test_release_mode_fails_on_unsigned(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _pe(tmp_path / "x.dll")
    _pe(tmp_path / "y.exe")
    monkeypatch.setattr(signatures.sys, "platform", "win32")
    verifier = _fake({"x.dll": UNSIGNED, "y.exe": VALID})
    out = tmp_path.parent / "inventory.json"
    assert signatures.main([str(tmp_path), "--out", str(out)], verifier) == 0
    assert signatures.main([str(tmp_path), "--release"], verifier) == 1
    assert "release blocked" in capsys.readouterr().out
    assert '"x.dll"' in out.read_text(encoding="utf-8")


def test_release_mode_passes_when_all_valid(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _pe(tmp_path / "y.exe")
    monkeypatch.setattr(signatures.sys, "platform", "win32")
    assert signatures.main([str(tmp_path), "--release"], _fake({"y.exe": VALID})) == 0


def test_release_mode_refuses_non_windows(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(signatures.sys, "platform", "linux")
    assert signatures.main([str(tmp_path), "--release"], _fake({})) == 2


def test_missing_directory(tmp_path: Path) -> None:
    assert signatures.main([str(tmp_path / "nope")], _fake({})) == 2


windows_only = pytest.mark.skipif(sys.platform != "win32", reason="needs Authenticode")


@windows_only
def test_real_verifier_accepts_signed_and_rejects_tampered(tmp_path: Path) -> None:
    base = Path(getattr(sys, "_base_executable", sys.executable))
    signed = shutil.copy2(base, tmp_path / "signed.exe")
    tampered = tmp_path / "tampered.exe"
    data = bytearray(Path(signed).read_bytes())
    data[len(data) // 2] ^= 0xFF
    tampered.write_bytes(bytes(data))
    result = signatures.powershell_verifier([Path(signed), tampered])
    assert result[Path(signed)].status == "Valid"
    assert result[tampered].status != "Valid"
