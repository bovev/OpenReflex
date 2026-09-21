# Windows packaging

Plan Task 0.3 is split into four owner-mandated subtasks. The native Windows real-model path stays a **release blocker** until 0.3d passes. Linux containers, WSL2, unsigned development builds, or signing only the installer/launcher don't count.

| Subtask | Status |
| --- | --- |
| 0.3a Fake-engine Windows packaging | done (dev machine), CI job added |
| 0.3b Native PE/DLL signature inventory | todo |
| 0.3c Complete release-payload signing | todo |
| 0.3d Clean-machine Application Control smoke test | todo |

## 0.3a: fake-engine `--onedir` package

`uv run python packaging/windows/build.py --smoke` (also `py scripts/verify.py --package-windows`, and the `package-windows` CI job).

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

The smoke report will include a fake-engine decision once the service contract exists (Task 2.1).
