---
task: 9
status: todo
depends_on: [8]
rework_rounds: 0
---

# Assemble the complete Windows release payload

## Goal
Produce signed-ready PyInstaller `--onedir` artifacts containing the service, MCP launcher, frontend, licenses, and notices, with deterministic packaged smoke coverage.

## Scope
`release/windows/`, packaging dependencies/configuration, package tests, and Windows CI. Installer authoring and actual code signing are separate tasks.

## Do
- Build production frontend assets before packaging and include them where the frozen service's existing UI discovery can find them.
- Produce runnable `openreflex-service.exe` and `openreflex-mcp.exe` artifacts with package data and runtime dependencies required by their real entry points.
- Include the project license, third-party notices, and locally served UI assets; do not include model weights.
- Ensure both executables discover mutable state only under the application data directory and locate each other using the packaged layout.
- Extend packaged smoke tests to start the service with an isolated data directory, load `/` and representative assets under CSP, run the existing fake decision, invoke MCP version/config modes, and verify generated configs reference the packaged MCP executable.
- Verify the MCP executable's stdout remains protocol/config clean and that neither executable modifies the installation directory.
- Inventory every PE file across the complete payload with the existing signature tooling. Non-release builds may report unsigned files; release mode must continue to fail closed.
- Build and smoke the complete payload in Windows CI through `py scripts/verify.py --package-windows`.

## Acceptance criteria
- [ ] The onedir payload runs without system Python, Node.js, Git, or model weights.
- [ ] The packaged UI, service API, fake decision, and MCP config modes pass smoke tests from a path containing spaces.
- [ ] Generated client snippets point to the packaged absolute `openreflex-mcp.exe`, not a source checkout or virtual environment.
- [ ] Runtime writes are confined to the isolated app-data directory and the packaged tree is unchanged after smoke tests.
- [ ] Signature inventory covers both executables and every nested PE file without exemptions.
- [ ] `py scripts/verify.py` and `py scripts/verify.py --package-windows` pass.

## Out of scope
- Signing any binary or acquiring credentials.
- Inno Setup installer creation.
- Native real-model execution on the Application-Control-managed development machine.
