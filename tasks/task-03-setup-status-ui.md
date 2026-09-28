---
task: 3
status: done
depends_on: [2]
accepted_at: d30dadb
rework_rounds: 4
replanned_at: cdc16a7
---

# Build setup and model status flows

## Goal
Implement the Setup screen so a user can understand readiness, explicitly download a model, follow progress, and recover from interruptions or errors.

## Scope
The frontend Setup screen, reusable safe-diagnostics formatting, API-client types needed by that screen, and focused tests. Backend changes are allowed only when an existing status/download contract cannot expose already-owned state safely.

## Do
- Show service reachability separately from offline-ready state, plus active/default profile, installed revision, verification time, download size, disk usage, and model state from `/v1/status` and `/v1/models`.
- Present `typed-decisions` as recommended. Keep `english`, `multilingual`, and `auto` visibly advanced and show their existing limitations without making accuracy claims.
- Before download, explain required network access, expected bytes/disk use, verification, resumability, and offline reuse.
- Start downloads only after an explicit button action. Poll status while downloading and display byte progress, current phase, completion, failure, and retry/verify actions. After every accepted download request, keep observing through the backend's temporary `not_installed` startup race until an installed, damaged, or recorded-error terminal state is returned.
- Treat each successful `/v1/models` poll as the current model snapshot. Recompute or update offline readiness from that snapshot everywhere it is presented, including diagnostics, so the screen and exported diagnostics cannot disagree after a default-model state change.
- If a download-status poll fails, retain the last model details but visibly mark the service temporarily unreachable and continue polling. The next successful poll must clear that warning and restore the reachable state without starting another download.
- Recover coherently when the page or service restarts during a partial download; never imply an interrupted model is installed.
- Use accessible status text in addition to color and an announced progress indicator.
- Add a diagnostics preview/copy/download action based on an explicit allowlist. Include operational versions and model states, but exclude the token, recipes, decision input/output, history entries, request bodies, home-directory details, and unfiltered exception text.
- Test not-installed, downloading, installed/offline-ready, damaged, interrupted, API-error, retry, and refresh-recovery states with deterministic fixtures. Include (1) completion from an initially `offline_ready: false` report and assert both the visible readiness and diagnostics preview become `yes`, and (2) a poll failure followed by a successful poll and assert temporary unreachability, continued observation, restored reachability, and exactly one download POST.

## Acceptance criteria
- [ ] No model download begins on service start, page load, profile selection, or status polling.
- [ ] Download progress and errors remain understandable without developer documentation and without relying on color alone.
- [ ] Refreshing during a download resumes status observation rather than starting a second download.
- [ ] After model polling changes default-model readiness, the Setup summary and diagnostics preview report the same current offline-ready value.
- [ ] A polling failure is shown as temporary service unreachability while observation continues; a later successful poll restores Reachable and updates model state without issuing another download request.
- [ ] Diagnostics are previewable before copy/download and tests prove excluded sensitive/content fields are absent.
- [ ] All model operations go through the authenticated `/v1` API.
- [ ] `py scripts/verify.py` passes.

## Out of scope
- Proving the first-run flow with a human participant.
- Downloading real weights in tests or ordinary verification.
- Model removal, which belongs on Settings.
