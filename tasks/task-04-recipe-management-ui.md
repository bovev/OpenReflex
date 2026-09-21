---
task: 4
status: todo
depends_on: [3]
rework_rounds: 0
---

# Build recipe management UI

## Goal
Provide form-based recipe listing, creation, editing, duplication, validation, import, export, and deletion through the product API.

## Scope
The Recipes screen, recipe form components and client-side types, API calls, and focused frontend tests. The product recipe schema itself may not be relaxed or replaced.

## Do
- List recipe metadata and clearly label seeded examples as demonstrations rather than production-validated policies.
- Implement a form for all schema-version-1 fields, including model profile, review threshold, and ordered `choice`, `score`, and `noul` questions.
- Preserve stable question IDs and option keys while editing; support adding, removing, and reordering questions/options within contract limits.
- Surface field-level server validation issues without echoing unrelated recipe content into logs.
- Implement create, replace, duplicate-to-a-new-ID, exact-ID-confirmed delete, and validate-without-saving through `/v1`.
- Keep YAML secondary: import a user-selected YAML file as text through `/v1/recipes/import`, and export through the API response. Never send a local path to the service.
- Warn before discarding unsaved edits and prevent accidental double submission.
- Test all three primitives, add/remove/reorder behavior, invalid IDs, server issues, duplicate IDs, import/export, overwrite handling, and delete confirmation.

## Acceptance criteria
- [ ] Every recipe operation uses the authenticated API; frontend code never accesses the recipe directory or submits path/URL source fields.
- [ ] Unknown or invalid fields cannot be silently discarded and saved as if valid.
- [ ] All schema-version-1 question and policy fields can be authored without editing YAML.
- [ ] YAML import reads only a file explicitly selected by the user and sends its bounded text, not its path.
- [ ] Deletion requires the exact recipe ID and API confirmation parameter.
- [ ] `py scripts/verify.py` passes.

## Out of scope
- Running decisions.
- Changing schema version 1 or adding templates, code, URL fetching, environment expansion, or filesystem recipe sources.
- Domain-specific policy recommendations.
