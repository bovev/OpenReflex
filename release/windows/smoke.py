"""Smoke-test the complete packaged payload (both executables, UI, notices).

The payload is copied to a directory whose path contains spaces and run with
a minimal environment: no Python, Node.js, or Git on ``PATH``, no Python
variables, and ``LOCALAPPDATA`` pointing at an isolated directory so the
executables' own default data-directory discovery is exercised.

Checks:

- both executables report the source version; the service self-check runs
  the fake decision;
- ``openreflex-mcp --print-config`` prints only JSON that references the
  packaged ``openreflex-mcp.exe``;
- a stdio MCP session (every stdout line is JSON-RPC) auto-starts the
  packaged service through the launcher and runs a fake decision;
- the service serves ``/`` and its assets under the CSP, the API runs a
  fake decision, and ``/v1/connections`` points at the packaged MCP;
- the packaged tree is unchanged and runtime writes stayed in app data.
"""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from openreflex import __version__
from openreflex.clients import SUPPORTED_CLIENTS
from openreflex.identity import (
    APP_DATA_DIR_NAME,
    MCP_EXECUTABLE,
    PRODUCT_NAME,
    SERVICE_EXECUTABLE,
)
from openreflex.lifecycle.instance import Discovered, InstanceLock, discover
from openreflex.security.middleware import CSP

TIMEOUT_S = 120.0
DECISION_INPUT = "We were charged twice for invoice 4471. Please refund."


class SmokeError(SystemExit):
    def __init__(self, message: str) -> None:
        super().__init__(f"smoke: {message}")


def executable(app: Path, name: str) -> Path:
    exe = app / f"{name}.exe"
    return exe if exe.exists() else app / name


def snapshot(folder: Path) -> dict[str, tuple[int, int]]:
    return {
        str(p.relative_to(folder)): (p.stat().st_size, p.stat().st_mtime_ns)
        for p in folder.rglob("*")
        if p.is_file()
    }


def isolated_env(root: Path) -> dict[str, str]:
    """A minimal environment: system directories only, isolated app data."""
    home = root / "home"
    local = root / "local app data"
    temp = root / "temp"
    for folder in (home, local, temp):
        folder.mkdir()
    env = {
        "TEMP": str(temp),
        "TMP": str(temp),
        "LOCALAPPDATA": str(local),
        "XDG_DATA_HOME": str(local),
        "USERPROFILE": str(home),
        "HOME": str(home),
        # The auto-started service must use the fake engine: no weights exist.
        "OPENREFLEX_ENGINE": "fake",
    }
    if sys.platform == "win32":
        system_root = os.environ.get("SYSTEMROOT", r"C:\Windows")
        env |= {
            "SystemRoot": system_root,
            "WINDIR": system_root,
            "SystemDrive": os.environ.get("SYSTEMDRIVE", "C:"),
            "PATH": f"{system_root}\\System32;{system_root}",
        }
    else:
        env["PATH"] = "/usr/bin:/bin"
    return env


def run(argv: list[str], env: dict[str, str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        env=env,
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=TIMEOUT_S,
    )


def check_versions(service: Path, mcp: Path, env: dict[str, str], cwd: Path) -> None:
    for argv in ([str(service), "version"], [str(mcp), "--version"]):
        proc = run(argv, env, cwd)
        if proc.returncode != 0 or proc.stdout.strip() != __version__:
            raise SmokeError(f"{argv[0]} version: {proc.stdout!r} {proc.stderr!r}")


def check_self_test(service: Path, env: dict[str, str], cwd: Path, app: Path, data: Path) -> None:
    proc = run([str(service), "smoke"], env, cwd)
    if proc.returncode != 0:
        raise SmokeError(f"self-check failed ({proc.returncode}):\n{proc.stdout}\n{proc.stderr}")
    report = json.loads(proc.stdout)
    if not report["frozen"]:
        raise SmokeError("the service does not report itself as frozen")
    if Path(report["install_dir"]).resolve() != app.resolve():
        raise SmokeError(f"wrong install dir {report['install_dir']}")
    if Path(report["data_dir"]).resolve() != data.resolve():
        raise SmokeError(f"wrong data dir {report['data_dir']}")
    if report["decision"]["status"] != "completed" or len(report["examples_seeded"]) != 4:
        raise SmokeError(f"fake decision failed: {report['decision']}")


def strings(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():  # pyright: ignore[reportUnknownVariableType]
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:  # pyright: ignore[reportUnknownVariableType]
            yield from strings(item)


def check_config_references(config: Any, mcp: Path, where: str) -> None:
    found = [s for s in strings(config) if s.lower().endswith((MCP_EXECUTABLE, ".exe"))]
    if not found or any(Path(s).resolve() != mcp.resolve() for s in found):
        raise SmokeError(f"{where} does not reference the packaged {mcp}: {found}")


def check_print_config(mcp: Path, env: dict[str, str], cwd: Path) -> None:
    for client in SUPPORTED_CLIENTS:
        proc = run([str(mcp), "--print-config", client], env, cwd)
        if proc.returncode != 0:
            raise SmokeError(f"--print-config {client} failed: {proc.stderr}")
        try:
            config = json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            raise SmokeError(f"--print-config {client} stdout is not only JSON: {exc}") from exc
        check_config_references(config, mcp, f"--print-config {client}")


class StdioSession:
    """A raw newline-delimited JSON-RPC session with the packaged MCP server."""

    def __init__(self, mcp: Path, env: dict[str, str], cwd: Path) -> None:
        self.proc = subprocess.Popen(
            [str(mcp)],
            env=env,
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if self.proc.stdin is None or self.proc.stdout is None or self.proc.stderr is None:
            raise SmokeError("could not open the MCP server's pipes")
        self.stdin, self.out, self.err = self.proc.stdin, self.proc.stdout, self.proc.stderr
        self.lines: queue.Queue[bytes | None] = queue.Queue()
        self.stdout: list[bytes] = []
        self.stderr: list[bytes] = []
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        threading.Thread(target=self._pump_stderr, daemon=True).start()

    def _pump_stdout(self) -> None:
        for line in self.out:
            self.stdout.append(line)
            self.lines.put(line)
        self.lines.put(None)

    def _pump_stderr(self) -> None:
        for line in self.err:
            self.stderr.append(line)

    def send(self, message: dict[str, Any]) -> None:
        self.stdin.write(json.dumps(message).encode() + b"\n")
        self.stdin.flush()

    def call(self, request_id: int, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + TIMEOUT_S
        while True:
            try:
                line = self.lines.get(timeout=max(0.0, deadline - time.monotonic()))
            except queue.Empty:
                raise SmokeError(f"MCP {method}: no response in time") from None
            if line is None:
                raise SmokeError(f"MCP server exited during {method}: {b''.join(self.stderr)!r}")
            message = json.loads(line)
            if message.get("id") == request_id:
                if "error" in message:
                    raise SmokeError(f"MCP {method} error: {message['error']}")
                return message["result"]

    def close(self) -> None:
        self.stdin.close()
        try:
            self.proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            raise SmokeError("the MCP server did not exit when stdin closed") from None
        for line in self.stdout:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                raise SmokeError(f"MCP stdout carried a non-JSON line: {line!r}") from None
            if message.get("jsonrpc") != "2.0":
                raise SmokeError(f"MCP stdout carried a non-JSON-RPC message: {line!r}")


def tool_payload(result: dict[str, Any], name: str) -> Any:
    if result.get("isError"):
        raise SmokeError(f"MCP tool {name} failed: {result}")
    if "structuredContent" in result:
        return result["structuredContent"]
    return json.loads(result["content"][0]["text"])


def check_mcp_session(mcp: Path, env: dict[str, str], cwd: Path) -> None:
    session = StdioSession(mcp, env, cwd)
    try:
        session.call(
            1,
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "openreflex-package-smoke", "version": __version__},
            },
        )
        session.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        tools = {tool["name"] for tool in session.call(2, "tools/list", {})["tools"]}
        if not {"list_recipes", "run_decision"} <= tools:
            raise SmokeError(f"unexpected MCP tools: {sorted(tools)}")
        # The first tool call auto-starts the packaged service via the launcher.
        listing = tool_payload(
            session.call(3, "tools/call", {"name": "list_recipes", "arguments": {}}),
            "list_recipes",
        )
        if "email-triage" not in json.dumps(listing):
            raise SmokeError(f"list_recipes did not include the examples: {listing}")
        decision = tool_payload(
            session.call(
                4,
                "tools/call",
                {
                    "name": "run_decision",
                    "arguments": {"recipe_id": "email-triage", "input": DECISION_INPUT},
                },
            ),
            "run_decision",
        )
        if decision.get("status") != "completed":
            raise SmokeError(f"MCP run_decision did not complete: {decision}")
    finally:
        session.close()


def http(
    found: Discovered, method: str, path: str, body: Any = None, auth: bool = True
) -> tuple[int, dict[str, str], bytes]:
    headers = {"Content-Type": "application/json"} if body is not None else {}
    if auth:
        headers["Authorization"] = f"Bearer {found.token}"
    request = urllib.request.Request(  # noqa: S310 - loopback http
        found.endpoint.base_url + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def check_http(found: Discovered, mcp: Path) -> None:
    status, headers, page = http(found, "GET", "/", auth=False)
    if status != 200 or headers.get("content-security-policy") != CSP:
        raise SmokeError(
            f"GET / returned {status} with CSP {headers.get('content-security-policy')}"
        )
    html = page.decode()
    if re.search(r"""(?:src|href)=["'](?:https?:)?//""", html):
        raise SmokeError("the UI references an external asset")
    assets = re.findall(r"""(?:src|href)=["'](/assets/[^"']+)["']""", html)
    if not any(a.endswith(".js") for a in assets) or not any(a.endswith(".css") for a in assets):
        raise SmokeError(f"the UI does not reference its script and stylesheet: {assets}")
    for asset in assets:
        status, headers, _ = http(found, "GET", asset, auth=False)
        if status != 200 or headers.get("content-security-policy") != CSP:
            raise SmokeError(f"GET {asset} returned {status}")
    status, _, body = http(
        found, "POST", "/v1/decisions", {"recipe_id": "email-triage", "input": DECISION_INPUT}
    )
    if status != 200 or json.loads(body)["status"] != "completed":
        raise SmokeError(f"API decision failed: {status} {body[:500]!r}")
    status, _, body = http(found, "GET", "/v1/connections")
    if status != 200:
        raise SmokeError(f"GET /v1/connections returned {status}")
    for connection in json.loads(body)["clients"]:
        check_config_references(
            connection["config"], mcp, f"/v1/connections {connection['client']}"
        )


def stop_service(data: Path) -> None:
    found = discover(data)
    if found is None:
        return
    http(found, "POST", "/v1/shutdown")
    # The OS releases the instance lock only when the service process exits.
    lock = InstanceLock(data)
    deadline = time.monotonic() + 30
    while not lock.try_acquire():
        if time.monotonic() > deadline:
            raise SmokeError("the service did not stop after /v1/shutdown")
        time.sleep(0.2)
    lock.release()


def run_smoke(app_dir: Path) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(
        prefix=f"{PRODUCT_NAME} smoke ", ignore_cleanup_errors=True
    ) as tmp:
        root = Path(tmp)
        app = root / "Program Files With Spaces" / PRODUCT_NAME
        shutil.copytree(app_dir, app)
        env = isolated_env(root)
        data = Path(env["LOCALAPPDATA"]) / APP_DATA_DIR_NAME
        service = executable(app, SERVICE_EXECUTABLE)
        mcp = executable(app, MCP_EXECUTABLE)
        before = snapshot(app)
        started = time.perf_counter()
        try:
            check_versions(service, mcp, env, root)
            cold_start_s = time.perf_counter() - started
            check_self_test(service, env, root, app, data)
            check_print_config(mcp, env, root)
            check_mcp_session(mcp, env, root)
            found = discover(data)
            if found is None:
                raise SmokeError("the MCP bridge did not leave a discoverable service running")
            if found.endpoint.version != __version__:
                raise SmokeError(f"the running service reports {found.endpoint.version}")
            check_http(found, mcp)
        finally:
            stop_service(data)
        if snapshot(app) != before:
            raise SmokeError("the install directory was modified at runtime")
        if [p.name for p in app.parent.iterdir()] != [PRODUCT_NAME]:
            raise SmokeError("files were written beside the install directory")
        if [p.name for p in data.parent.iterdir()] != [APP_DATA_DIR_NAME]:
            raise SmokeError("files were written to app data outside the product directory")
        return {
            "version": __version__,
            "cold_start_s": round(cold_start_s, 2),
            "installed_bytes": sum(p.stat().st_size for p in app.rglob("*") if p.is_file()),
            "files": len(before),
        }
