"""Real-process lifecycle tests. These never load weights or contact the network."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

from openreflex.lifecycle.instance import STATE_FILE, Discovered, discover, is_owned
from openreflex.lifecycle.launcher import ensure_running
from openreflex.paths import DATA_DIR_ENV
from openreflex.settings import ENGINE_ENV

_TIMEOUT_S = 15.0


def _command(*args: str) -> list[str]:
    return [sys.executable, "-m", "openreflex.cli", *args]


def _environment(root: Path) -> dict[str, str]:
    return {**os.environ, DATA_DIR_ENV: str(root), ENGINE_ENV: "fake", "PYTHONUTF8": "1"}


def _run(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        _command(*args),
        env=_environment(root),
        capture_output=True,
        text=True,
        timeout=_TIMEOUT_S,
        check=False,
    )


def _start(root: Path) -> subprocess.Popen[str]:
    return subprocess.Popen(
        _command("serve"),
        env=_environment(root),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _wait_for_service(root: Path, process: subprocess.Popen[str]) -> Discovered:
    deadline = time.monotonic() + _TIMEOUT_S
    while time.monotonic() < deadline:
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            raise AssertionError(
                f"service exited with {process.returncode}\nstdout:\n{stdout}\nstderr:\n{stderr}"
            )
        found = discover(root)
        if found is not None:
            return found
        time.sleep(0.05)
    raise AssertionError("service did not become discoverable")


def _wait_for_stop(root: Path) -> None:
    deadline = time.monotonic() + _TIMEOUT_S
    while time.monotonic() < deadline:
        if not is_owned(root):
            return
        time.sleep(0.05)
    raise AssertionError("service did not stop")


def _kill(process: subprocess.Popen[str]) -> None:
    if process.poll() is None:
        process.kill()
    process.wait(timeout=_TIMEOUT_S)
    if process.stdout is not None:
        process.stdout.close()
    if process.stderr is not None:
        process.stderr.close()


def test_launcher_reuses_service_second_instance_refuses_and_stop(tmp_path: Path) -> None:
    root = tmp_path / "data"
    found = ensure_running(
        root,
        argv=_command("serve"),
        timeout_s=_TIMEOUT_S,
        extra_env={ENGINE_ENV: "fake", "PYTHONUTF8": "1"},
    )
    try:
        assert discover(root) == found

        # UI and MCP callers both use this launcher. Once discovered, no new
        # command is started, even if the supplied command cannot exist.
        reused = ensure_running(root, argv=[str(tmp_path / "must-not-run")])
        assert reused == found

        second = _run(root, "serve")
        assert second.returncode == 0
        assert f"already running at {found.endpoint.base_url}" in second.stderr
        assert discover(root) == found

        status = _run(root, "status")
        assert status.returncode == 0
        report = json.loads(status.stdout)
        assert report["running"] is True
        assert report["pid"] == found.endpoint.pid
        assert report["port"] == found.endpoint.port

        stopped = _run(root, "stop")
        assert stopped.returncode == 0
        _wait_for_stop(root)
        assert discover(root) is None
        assert not (root / STATE_FILE).exists()
    finally:
        if discover(root) is not None:
            _run(root, "stop")
            _wait_for_stop(root)


def test_crash_releases_lock_and_stale_metadata_is_replaced(tmp_path: Path) -> None:
    root = tmp_path / "data"
    first_process = _start(root)
    second_process: subprocess.Popen[str] | None = None
    try:
        first = _wait_for_service(root, first_process)
        first_process.kill()
        first_process.wait(timeout=_TIMEOUT_S)
        _wait_for_stop(root)

        assert (root / STATE_FILE).is_file()
        assert not is_owned(root)
        assert discover(root) is None
        stale = first.endpoint.model_copy(update={"port": 1})
        (root / STATE_FILE).write_text(stale.model_dump_json(indent=2), encoding="utf-8")

        second_process = _start(root)
        second = _wait_for_service(root, second_process)
        assert second.endpoint.port == first.endpoint.port
        assert second.endpoint != stale
        assert (root / STATE_FILE).read_text(encoding="utf-8") == (
            second.endpoint.model_dump_json(indent=2)
        )

        assert _run(root, "stop").returncode == 0
        second_process.wait(timeout=_TIMEOUT_S)
        assert not is_owned(root)
        assert not (root / STATE_FILE).exists()
    finally:
        _kill(first_process)
        if second_process is not None:
            _kill(second_process)
