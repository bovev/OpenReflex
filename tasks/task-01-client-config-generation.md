---
task: 1
status: todo
depends_on: []
rework_rounds: 0
---

# Generate MCP client configuration

## Goal
Generate safe, current MCP configuration for Claude Code, OpenCode, and VS Code/GitHub Copilot from the installed `openreflex-mcp` path, without editing third-party configuration files.

## Scope
The shared product/configuration modules, MCP CLI, authenticated `/v1` connection metadata, related tests, client setup documentation, and the owner-approved client-list deviation in `docs/architecture/progress.md`. No frontend implementation belongs in this task.

## Do
- Record that V1 requires Claude Code, OpenCode, and VS Code/GitHub Copilot; Claude Desktop is no longer required.
- Add one product-owned configuration generator with injectable path resolution so the CLI, API, tests, and later UI use identical output.
- Support stable client identifiers for `claude-code`, `opencode`, and `vscode-copilot`.
- Generate the current documented stdio shape for each client. OpenCode output must include its schema declaration and use a local MCP `command` array; all clients must invoke the executable directly with no shell.
- Resolve the installed absolute `openreflex-mcp.exe` path. Correctly JSON-escape Windows paths containing spaces and non-ASCII characters.
- Add `openreflex-mcp --print-config <client>` as a non-server mode. It must print only valid JSON to stdout and exit without claiming stdio for MCP.
- Add an authenticated read-only `/v1/connections` response suitable for the later Connections screen. Include generated configuration plus concise setup, restart, and removal steps, but no bearer token or mutable client path.
- Document the authoritative schema/documentation source and verification date for each client.
- State that external AI clients may process submitted content remotely and that OpenReflex never silently merges or overwrites client configuration.
- Test every output shape, path escaping, deterministic output, CLI stdout cleanliness, API authentication, and absence of development-only paths when a packaged path is supplied.

## Acceptance criteria
- [ ] Claude Code, OpenCode, and VS Code/GitHub Copilot each have valid, schema-appropriate generated JSON using an absolute executable path.
- [ ] `--print-config` does not start the MCP server and writes no explanation or logs to stdout.
- [ ] The generator and API never read, create, or modify a client's configuration file.
- [ ] Setup and removal instructions preserve unrelated user configuration and include the external-client privacy distinction.
- [ ] Tests cover paths with spaces, quotes/backslashes, and non-ASCII characters.
- [ ] `py scripts/verify.py` passes.

## Out of scope
- A Connections UI.
- Installing or launching third-party clients.
- Manual end-to-end client smoke tests.
- Claude Desktop support.
