---
task: 6
status: todo
depends_on: [1, 5]
rework_rounds: 0
---

# Build the Connections screen

## Goal
Expose safe, copyable MCP setup and removal guidance for every required V1 client through the local UI.

## Scope
The Connections screen and its frontend tests. Configuration generation remains owned by Task 1 and must not be duplicated in TypeScript.

## Do
- Consume authenticated `/v1/connections` data for Claude Code, OpenCode, and VS Code/GitHub Copilot.
- Show client-specific setup location/scope, generated JSON, restart instructions, verification steps, and removal instructions.
- Provide accessible copy controls with explicit success/failure feedback and no automatic clipboard read.
- Explain how to merge the named OpenReflex entry without replacing unrelated MCP servers or client settings.
- Repeat that OpenReflex inference is local but content sent through an external AI client may be processed under that client's terms.
- Never write client configuration, launch a client, expose the bearer token, or place configuration into a remote link.
- Test all required clients, copy behavior, missing configuration, API failure, path escaping display, and keyboard operation.

## Acceptance criteria
- [ ] The screen covers Claude Code, OpenCode, and VS Code/GitHub Copilot and no longer presents Claude Desktop as required.
- [ ] Displayed snippets are the exact server-generated objects rather than independently reconstructed frontend shapes.
- [ ] Setup and removal guidance explicitly preserves unrelated user configuration.
- [ ] The privacy/locality explanation is visible before the setup steps.
- [ ] No screen action mutates a third-party configuration file or silently starts an external program.
- [ ] `py scripts/verify.py` passes.

## Out of scope
- Manual client smoke tests.
- Client installation or configuration-file editing.
- Remote MCP transport.
