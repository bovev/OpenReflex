# Current task

- Task: `task-03-setup-status-ui.md`
- Round: 5
- Baseline: `4c9c517bf11d3a60fc0cb82c89297d4ec896f1b4`
- Stage: accepted
- Blocking review finding: cleaned-up polling effects do not invalidate in-flight completions, allowing stale snapshots to overwrite a new download and stop observation.
- Blocking review finding: overlapping asynchronous polls permit stale failures to leave the UI temporarily unreachable after polling has stopped.
- Blocking findings: diagnostics retain stale offline readiness after polling; polling failures do not surface temporary service unreachability or recovery.
