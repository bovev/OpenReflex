---
task: 13
status: todo
depends_on: [11, 12]
rework_rounds: 0
---

# Complete release-facing documentation

## Goal
Provide an accurate, self-contained quick start, recipe guide, privacy explanation, troubleshooting, and uninstall guide aligned with the implemented product and remaining release blockers.

## Scope
Repository Markdown documentation, deterministic screenshots produced from fake data, documentation-link tests, and factual updates to `docs/architecture/progress.md`. No release blocker may be marked complete without its required evidence.

## Do
- Expand the README with a plain-language two-minute quick start for install, first model download, first local decision, and connection discovery.
- Add a recipe authoring guide covering all three primitives, review thresholds, good/bad examples, strict validation, portability, and demonstration-policy warnings.
- Add a local-versus-external-AI privacy guide that distinguishes local inference from Claude Code, OpenCode, and Copilot processing and avoids unsupported offline/privacy claims.
- Complete setup/removal guides for the three required clients using the generated configuration source of truth.
- Add troubleshooting for downloads/resume/verification, antivirus/Application Control, memory pressure, service discovery/token relaunch, client config merge/removal, queue saturation, and damaged models.
- Document install, upgrade, default uninstall preservation, explicit model/data removal, and the exact app-data location.
- Publish known model limitations and release-note content covering confidence, calibration, truncation, high-cardinality choices, score limitations, and remaining signing/license/Application Control blockers.
- Generate stable screenshots from the fake browser fixture with no token, user path, recipe content, or decision content beyond approved demonstration fixtures.
- Update progress notes with precise implemented/automated status. Keep 0.3c, 0.3d, final checkpoint-license review, manual client smoke tests, and 6.3 visibly incomplete.
- Add link/image checks so documentation cannot reference missing repository assets.

## Acceptance criteria
- [ ] A reader can find install/use, recipe authoring, client setup/removal, privacy, troubleshooting, uninstall/data-removal, limitations, attribution, and notices from the README.
- [ ] Documentation consistently names Claude Code, OpenCode, and VS Code/GitHub Copilot as required V1 clients and does not claim Claude Desktop support is required.
- [ ] No document claims universal accuracy/calibration, a fully offline external-client workflow, completed signing, approved checkpoint terms, or passed human usability testing.
- [ ] Screenshots are deterministic, use only approved fake/demo data, and expose no token or machine-specific path.
- [ ] Progress reporting preserves every external/human release blocker rather than declaring V1 complete.
- [ ] `py scripts/verify.py` passes, including documentation links/assets.

## Out of scope
- Signing or publishing a release.
- Manual client, clean-machine, or non-developer usability tests.
- Legal approval of licenses or redistribution terms.
