# Windows packaging

Plan Task 0.3 is split into four owner-mandated subtasks. The native Windows real-model path stays a **release blocker** until 0.3d passes. Linux containers, WSL2, unsigned development builds, or signing only the installer/launcher don't count.

| Subtask | Status |
| --- | --- |
| 0.3a Fake-engine Windows packaging | done (dev machine), CI job added |
| 0.3b Native PE/DLL signature inventory | done: tooling in place, current payload fails release mode as expected |
| 0.3c Complete release-payload signing | todo |
| 0.3d Clean-machine Application Control smoke test | todo |

## Complete release payload (0.3a, extended by repo task 9)

`uv run --group package python release/windows/build.py --smoke` (also `py scripts/verify.py --package-windows`, which is what the `package-windows` CI job runs).

`build.py` builds the production UI (`npm run --workspace frontend build`), then runs `release/windows/openreflex.spec`: one `--onedir` folder, `release/windows/output/dist/OpenReflex/`, holding

| Path | Contents |
| --- | --- |
| `openreflex-service.exe` | Service CLI (`serve`, `open`, `status`, `stop`, `version`, `smoke`) |
| `openreflex-mcp.exe` | stdio MCP bridge (`--version`, `--print-config CLIENT`) |
| `_internal/` | One Python runtime shared by both executables |
| `ui/` | Production UI assets, found by the frozen service at `<install>/ui` |
| `LICENSE`, `THIRD_PARTY_NOTICES.md` | Project license and notices |

The executables sit side by side because the MCP launcher finds the service as its sibling, and generated client configs point at the sibling `openreflex-mcp.exe`. Model weights are never bundled: the build fails if a weight-like file appears in the payload.

The smoke test (`release/windows/smoke.py`) copies the payload into a path containing spaces and runs it with a minimal environment: only the Windows system directories on `PATH` (no Python, Node.js, or Git), no Python variables, and `LOCALAPPDATA` pointing at an isolated directory, so the executables' own default data-directory discovery is used. It checks that:
- both executables report the source version, and the service self-check (`smoke`) seeds the examples and completes a fake decision;
- `openreflex-mcp --print-config` prints only JSON, for every supported client, and that JSON references the packaged `openreflex-mcp.exe`;
- a raw stdio MCP session (initialize, list tools, `list_recipes`, `run_decision`) auto-starts the packaged service through the launcher, and every stdout line is JSON-RPC;
- the running service serves `/` and every referenced asset with the production CSP, the UI references no external asset, the API completes a fake decision, and `/v1/connections` references the packaged `openreflex-mcp.exe`;
- after an authenticated shutdown, the packaged tree is byte-for-byte unchanged (size and mtime), nothing was written beside it, and nothing was written under app data outside `OpenReflex/`.

Measured on the dev machine (2026-09-23, Windows 11, Python 3.14, PyInstaller 6.22.3, fake engine):

| Metric | Value |
| --- | --- |
| Payload | 43.7 MB, 103 files |
| Both `version` commands, freshly copied payload | 3.6 s |
| Model-load / first-decision latency | n/a for the fake engine. Native Windows real-model numbers are blocked (see below). |

On the Application-Control-managed dev machine, the first build on 2026-09-23 passed the full smoke. Later rebuilds (new hashes, still unsigned) were blocked (`WinError 4551`): `openreflex-mcp.exe` even in place, and both executables from the smoke copy. This is the unsigned-binary problem 0.3c/0.3d exist for. Don't work around it by moving where the smoke runs. Until signing exists, the `package-windows` CI job is the authoritative run.

A real-model build adds torch's DLLs. On the dev machine, Windows Application Control blocks torch's `shm.dll` natively, which is why 0.3b–0.3d exist.

## 0.3b: native PE signature inventory

`release/windows/signatures.py <package-dir> [--release] [--out FILE]`. `build.py` always writes `release/windows/output/signature-inventory.json`. `build.py --release` fails the build.

- It finds PE files by their MZ/PE header, not by extension, so a renamed DLL can't slip through. The inventory records path, size, sha256, status, signer, timestamp, and catalog signing.
- Verification uses Windows' `Get-AuthenticodeSignature`. Anything other than `Valid` fails, including `NotSigned`, `HashMismatch`, `UnknownError`, a missing result, and a PowerShell error. In release mode **every** PE file is required, with no exemption list. Release mode refuses to run off Windows.
- The subprocess drops an inherited `PSModulePath`. Without that, running from PowerShell 7 stops Windows PowerShell from loading `Microsoft.PowerShell.Security`, and every file came back as `Error` (it failed closed).

Complete payload (2026-09-23, repo task 9): 36 PE files, 26 valid, 10 not. The inventory covers both executables and every nested PE file, with no exemptions.

| Files | Signer |
| --- | --- |
| `python314.dll`, `libcrypto-3.dll`, `libssl-3.dll`, stdlib `.pyd` files | Python Software Foundation |
| `VCRUNTIME140.dll` | Microsoft Windows Software Compatibility Publisher |
| `openreflex-service.exe`, `openreflex-mcp.exe` (PyInstaller bootloader) | **NotSigned** |
| `pydantic_core/_pydantic_core.cp314-win_amd64.pyd`, `rpds/rpds.cp314-win_amd64.pyd`, `yaml/_yaml.cp314-win_amd64.pyd` | **NotSigned** (PyPI wheels) |
| `pywin32_system32/pywintypes314.dll`, `win32/_win32sysloader.pyd`, `win32/win32api.pyd`, `win32/win32evtlog.pyd`, `win32/win32job.pyd` | **NotSigned** (pywin32, pulled in by the MCP SDK on Windows) |

What to expect: the full service adds third-party extension modules (pydantic-core, PyYAML, and later the web server and MCP stack). A real-model build adds torch, tokenizers, safetensors, and numpy. PyPI wheels generally ship these **unsigned**. 0.3c must sign every one of them with the project's certificate, or replace them with signed builds. Signing only the launcher or installer does not satisfy the requirement.
