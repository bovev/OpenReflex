---
task: 8
status: done
depends_on: [3, 4, 5, 6, 7]
rework_rounds: 0
---

# Add frontend accessibility and browser coverage

## Goal
Verify the complete five-screen UI in a real browser against a deterministic local fake service, including keyboard and automated accessibility checks.

## Scope
Frontend accessibility fixes, browser-test tooling and fixtures, a test-only fake-service launcher, CI/setup documentation, and verification wiring. Production security behavior may not be bypassed.

## Do
- Add pinned browser end-to-end tooling and ensure required browser binaries are installed in CI and documented for local setup.
- Start an actual loopback HTTP service with a temporary data directory, deterministic fake engine, fake model artifact source, real auth middleware, and no network/model downloads.
- Exercise token-fragment bootstrap and all five screens through public UI/API behavior rather than component internals.
- Cover setup/download/recovery, recipe create/edit/import/export/delete, all three decision primitives and review/warning states, generated connections, history settings, diagnostics, and model removal.
- Add automated accessibility checks for landmarks, names, labels, headings, dialog focus, contrast, status announcements, and color-independent meaning.
- Add a keyboard-only path through every primary workflow with visible focus and predictable focus restoration.
- Assert the browser makes no requests to non-loopback origins and that production assets work under the real CSP.
- Make browser tests part of the single supported verification command; do not silently skip them when a browser is missing.

## Acceptance criteria
- [ ] Browser tests use the fake engine/artifact source and perform no network access outside the test service.
- [ ] Every primary workflow is covered through rendered UI and authenticated HTTP behavior.
- [ ] Automated accessibility checks report no serious/critical violations on any V1 screen or modal state.
- [ ] Keyboard-only tests cover navigation, forms, copy controls, confirmations, and decision execution.
- [ ] Tests prove no external asset, analytics, model, or API request is made.
- [ ] `py scripts/verify.py` passes and includes the browser suite.

## Out of scope
- Human usability testing or assistive-technology certification.
- Real model weights.
- Visual branding or broad screenshot-regression infrastructure.
