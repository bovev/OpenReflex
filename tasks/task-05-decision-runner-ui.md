---
task: 5
status: todo
depends_on: [4]
rework_rounds: 0
---

# Build decision runner and result views

## Goal
Implement the Try a decision screen for bounded text or JSON input and render complete, primitive-specific decision results without overstating confidence.

## Scope
The decision screen, result components, API-client types/calls, preflight warnings, and focused tests. Backend result contracts may not be changed merely for display convenience.

## Do
- Let the user select a recipe and choose plain-text or JSON input. Validate JSON locally for usability while treating strings that resemble paths or URLs as inert content.
- Submit only the existing `DecisionRequest` shape to `/v1/decisions`; never open, resolve, upload, or fetch input strings.
- Disable duplicate submissions, support cancellation, distinguish queue saturation/retry guidance from model-not-ready and validation failures, and preserve user input only in component memory.
- Before running, warn about high-cardinality choices and inputs likely to hit documented limits without claiming to predict exact model behavior.
- Render `choice`, `score`, and `noul` answers and distributions, raw confidence/probability, review state, every warning, status, actual checkpoint/revision, and latency.
- Display `needs_review` separately from probability and explain that neither confidence nor review state proves correctness.
- Ensure errors and diagnostics do not log or copy decision input, answers, or full result payloads.
- Test completed, low-confidence, truncation-warning, needs-review, queue-full, model-not-ready, timeout, failure, malformed JSON, and each primitive's result shape.

## Acceptance criteria
- [ ] Path- and URL-looking strings are accepted as inert text but are never opened or retrieved.
- [ ] Review state, probability/confidence, and warnings are visually and semantically distinct and do not rely on red/green alone.
- [ ] The UI renders all warnings and the actual checkpoint and pinned revision returned by the service.
- [ ] No automatic retry can execute a decision twice.
- [ ] Tests assert that input and answer content are absent from logs and diagnostics.
- [ ] `py scripts/verify.py` passes.

## Out of scope
- Calibration or accuracy claims.
- File, URL, attachment, clipboard-monitoring, or connector-based decision sources.
- Automatic downstream actions.
