# Windows packaging

Plan Task 0.3 is split into four owner-mandated subtasks. The native Windows real-model path stays a **release blocker** until 0.3d passes. Linux containers, WSL2, unsigned development builds, or signing only the installer/launcher don't count.

| Subtask | Status |
| --- | --- |
| 0.3a Fake-engine Windows packaging | done (dev machine), CI job added |
| 0.3b Native PE/DLL signature inventory | done: tooling in place, current payload fails release mode as expected |
| 0.3c Complete release-payload signing | todo |
| 0.3d Clean-machine Application Control smoke test | todo |

## 0.3a: fake-engine `--onedir` package

`uv run python release/windows/build.py --smoke` (also `py scripts/verify.py --package-windows`, and the `package-windows` CI job).

The smoke test runs the frozen `openreflex-service.exe smoke` with Python variables removed from the environment and an isolated `OPENREFLEX_DATA_DIR`. It checks:
- the executable reports itself as frozen and resolves its own install dir;
- it writes to the data directory;
- the install directory is unchanged afterwards (no mutable state next to program files).

Measured on the dev machine (2026-09-21, Windows 11, Python 3.14.1, PyInstaller 6.22.3, no model dependencies yet):

| Metric | Value |
| --- | --- |
| Package size | 18.6 MB, 17 files |
| Cold start, first run of a new build | 12.9 s. Appears to be a one-time scan of the unsigned binary; re-measure on the clean VM in 0.3d. |
| Cold start, subsequent runs | 0.07 s |
| Model-load / first-decision latency | n/a for the fake engine. Native Windows real-model numbers are blocked (see below). |

The payload already contains native PE files: `python3xx.dll`, `VCRUNTIME140.dll`, `libcrypto-3.dll`, `libssl-3.dll`, and several `.pyd` extension modules. A real-model build adds torch's DLLs. On the dev machine, Windows Application Control blocks torch's `shm.dll` natively, which is why 0.3b–0.3d exist.

Since Task 2.1, the smoke test also seeds the example recipes into the isolated data directory and runs `email-triage` through the fake engine. It fails unless the decision completes.

## 0.3b: native PE signature inventory

`release/windows/signatures.py <package-dir> [--release] [--out FILE]`. `build.py` always writes `release/windows/output/signature-inventory.json`. `build.py --release` fails the build.

- It finds PE files by their MZ/PE header, not by extension, so a renamed DLL can't slip through. The inventory records path, size, sha256, status, signer, timestamp, and catalog signing.
- Verification uses Windows' `Get-AuthenticodeSignature`. Anything other than `Valid` fails, including `NotSigned`, `HashMismatch`, `UnknownError`, a missing result, and a PowerShell error. In release mode **every** PE file is required, with no exemption list. Release mode refuses to run off Windows.
- The subprocess drops an inherited `PSModulePath`. Without that, running from PowerShell 7 stops Windows PowerShell from loading `Microsoft.PowerShell.Security`, and every file came back as `Error` (it failed closed).

Current fake-engine payload (2026-09-21, after Task 2.1): 42 files, 28.5 MB. 27 PE files: 24 valid, 3 not.

| Files | Signer |
| --- | --- |
| `python314.dll`, `libcrypto-3.dll`, `libssl-3.dll`, stdlib `.pyd` files | Python Software Foundation |
| `VCRUNTIME140.dll` | Microsoft Windows Software Compatibility Publisher |
| `openreflex-service.exe` (PyInstaller bootloader) | **NotSigned** |
| `pydantic_core/_pydantic_core.cp314-win_amd64.pyd` | **NotSigned** (PyPI wheel) |
| `yaml/_yaml.cp314-win_amd64.pyd` | **NotSigned** (PyPI wheel) |

What to expect: the full service adds third-party extension modules (pydantic-core, PyYAML, and later the web server and MCP stack). A real-model build adds torch, tokenizers, safetensors, and numpy. PyPI wheels generally ship these **unsigned**. 0.3c must sign every one of them with the project's certificate, or replace them with signed builds. Signing only the launcher or installer does not satisfy the requirement.
