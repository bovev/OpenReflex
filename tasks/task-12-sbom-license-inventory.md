---
task: 12
status: todo
depends_on: [10]
rework_rounds: 0
---

# Generate SBOM and dependency license inventory

## Goal
Generate deterministic release inventories for Python, JavaScript, installer, packaged native, and model components while preserving explicit owner/legal blockers.

## Scope
Release inventory tooling, generated SBOM/license artifacts, third-party notices, drift checks, and focused tests. Final legal conclusions about ambiguous terms are out of scope.

## Do
- Generate a standard machine-readable SBOM from locked Python and npm dependencies plus the packaged application components; make ordering and timestamps deterministic or normalized for drift checking.
- Inventory direct/transitive Python and JavaScript packages, Python runtime/PyInstaller components, Inno Setup, bundled native files, Laya, and every configured model checkpoint/revision.
- Record component name, version/revision, source, license expression/evidence, distribution role, required notice/license files, and review state.
- Include required license/NOTICE text in the release payload where redistribution requires it, without copying upstream source code.
- Correlate packaged native files with their supplying component where tooling can establish it; flag unowned files as errors rather than guessing.
- Keep checkpoint redistribution/automatic-download terms explicitly pending owner/legal verification unless authoritative evidence resolves them. Do not convert repository metadata alone into approval.
- Add tests for deterministic generation, complete lockfile coverage, notice inclusion, unknown-license handling, and payload/SBOM drift.
- Integrate generated-artifact drift checks into `py scripts/verify.py` after existing contract checks without network access.

## Acceptance criteria
- [ ] Every locked and shipped software component appears in the generated inventory and SBOM or causes generation to fail.
- [ ] Every packaged PE/native file is attributable to an inventoried component or is reported as unresolved.
- [ ] Required notices are included in both source and installed release payloads.
- [ ] Pending checkpoint terms remain clearly marked as a release blocker and are not represented as legally approved.
- [ ] Generated outputs are deterministic and verification fails when locks or payload manifests drift.
- [ ] `py scripts/verify.py` passes.

## Out of scope
- Legal advice or owner acceptance of licenses.
- Resolving the checkpoint-license release blocker.
- Signing binaries or publishing release artifacts.
