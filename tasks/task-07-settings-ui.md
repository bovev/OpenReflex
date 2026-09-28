---
task: 7
status: done
depends_on: [6]
accepted_at: 84d773f
rework_rounds: 0
---

# Build settings and local-data controls

## Goal
Implement Settings controls for history, diagnostics, model removal, local paths, versions, and dependency notices while preserving privacy-safe defaults.

## Scope
The Settings screen, shared diagnostics reuse, authenticated API calls, and focused tests. New persistence preferences require an explicit product decision and are out of scope.

## Do
- Show app/version information, the data directory as read-only information, attribution, and links or bundled views for project and third-party notices.
- Show that history is off by default and the API's exact `what_is_stored` explanation before opt-in.
- Require explicit confirmation before enabling history and before clearing history; use `/v1/preferences` and `/v1/history` only.
- Reuse the safe diagnostics preview/copy/download implementation from Setup rather than adding broader fields.
- List installed models with profile, revision, disk use, and verification state. Require exact-profile confirmation before API removal and explain that removal is separate from uninstall.
- Keep destructive controls disabled while the relevant operation is pending and render structured API failures safely.
- Test default history-off behavior, opt-in/out, clear history, notices, diagnostics, installed/damaged/downloading model states, confirmation, busy errors, and successful removal.

## Acceptance criteria
- [ ] History remains disabled until an explicit confirmed action and the UI accurately states what is stored.
- [ ] Clearing history and removing a model each require a distinct explicit confirmation.
- [ ] The UI cannot change the data directory or delete recipes as a side effect of model removal.
- [ ] Notices and required Laya attribution are available without an external network request.
- [ ] Diagnostics retain the sensitive/content exclusions established in Task 3.
- [ ] `py scripts/verify.py` passes.

## Out of scope
- Changing the history persistence default.
- Telemetry, cloud sync, auto-update, or selecting arbitrary model directories.
- Uninstaller data-removal behavior.
