# Local Decision Hub — Implementation Plan

Status: implementation-ready draft  
Working title: **Local Decision Hub** (replace before public release)  
Primary target: Windows 11 x64, CPU-first  
Upstream engine: [Laya](https://github.com/NandhaKishorM/laya)  
Plan baseline: 2026-09-21

## 1. Mission

Build an independent, open-source desktop product that lets an ordinary organizational user install and run Laya locally, define reusable decision recipes, try them in a simple UI, and invoke them from MCP-capable tools such as Claude Desktop, Claude Code, GitHub Copilot, VS Code, and OpenCode.

The product is not a fork of Laya and must not import Laya's Git history. Laya is an upstream dependency behind a small internal adapter. The repository must remain technically independent while giving visible attribution to Laya and Convai Innovations.

The core product promise is:

> Run a fast System 1 decision model on your own computer and use it from the tools you already work in.

Be precise in privacy claims:

- Laya inference and recipe storage run locally.
- No hosted inference API is required.
- The product can work offline after the selected model and runtime have been downloaded.
- If a user sends content through Claude, Copilot, or another cloud AI tool, that tool may process the content under its own architecture and data terms. Do not describe that end-to-end workflow as fully offline.

## 2. Product thesis

Large language models are useful for language and open-ended reasoning. Laya is useful for fast, repetitive, typed decisions. This project connects the two without asking users to understand Python, Hugging Face, model checkpoints, JSON schemas, or local inference infrastructure.

The defensible layer is not a new inference engine. It is the local product experience around the engine:

- installation and lifecycle management;
- model download and selection;
- a stable local decision API;
- reusable, validated decision recipes;
- confidence and human-review policies;
- a local testing UI;
- MCP integration and client setup guidance;
- honest presentation of model limits;
- secure localhost-only defaults.

## 3. V1 user story

The target user can:

1. Download and install one Windows package.
2. Launch the app without installing Python, Git, Node.js, or CUDA.
3. Download the recommended Laya checkpoint through a guided first-run screen.
4. Create or import a decision recipe.
5. Paste text or JSON into the local UI and see typed answers, probabilities, warnings, model information, and latency.
6. Connect the installed MCP server to a supported AI client using generated configuration.
7. Ask the AI client to list recipes, run a recipe, validate a proposed recipe, or save a recipe after user approval.
8. Continue using existing downloaded models without an internet connection.

V1 succeeds when a non-developer can install the product and run a first local decision from the UI in five minutes, then connect one MCP client in another five minutes using the included instructions.

## 4. Scope

### Included in V1

- Windows 11 x64 installer.
- CPU-only runtime as the supported baseline.
- Local service bound only to `127.0.0.1`.
- Laya integration through a versioned adapter.
- Support for Laya's `choice`, `score`, and `noul` primitives.
- Versioned YAML decision recipes.
- Recipe create, edit, validate, import, export, list, and run operations.
- Simple local web UI served by the installed backend.
- Local REST API with generated OpenAPI documentation disabled in production by default.
- Local stdio MCP bridge.
- Setup instructions and generated configuration for at least Claude Desktop and VS Code/GitHub Copilot.
- Model download, readiness, version, disk usage, and removal controls.
- Confidence thresholds and explicit `needs_review` results.
- Structured local logs that exclude user inputs and decision content.
- Optional decision history, disabled by default.
- Automated unit, contract, integration, security, and packaging tests.
- Clear Laya attribution and third-party notices.

### Explicit non-goals for V1

- Reimplementing Laya inference.
- Forking or modifying Laya internals.
- Cloud inference, user accounts, telemetry, or a hosted control plane.
- Remote/network API access.
- Automatically performing downstream business actions.
- Email, SharePoint, filesystem, or database connectors.
- Fine-tuning inside the desktop application.
- macOS and Linux installers.
- GPU acceleration as a supported user path.
- Background auto-update.
- Enterprise fleet management.
- Claiming that raw model confidence is universally calibrated or safe for automation.

## 5. Upstream facts and product implications

At the plan baseline, Laya is an Apache-2.0 Python package installed with `pip install laya`. It exposes `choice`, `score`, and `noul` questions and three checkpoints: English, multilingual, and typed-decisions. It also exposes a `Router`.

Laya's own documentation describes important constraints that this product must surface:

- the base checkpoints perform poorly on some typed-decision zero-shot tests;
- the typed-decisions checkpoint is specialized and should be the default for organizational decision recipes;
- the English and multilingual checkpoints have different strengths;
- shipped confidence can be over-confident without domain calibration;
- long inputs are truncated by finite model context;
- large choice sets compete for a limited prompt budget and can degrade sharply;
- ordinal `score` is currently weaker than the other primitives.

Therefore:

1. Default to the `typed-decisions` model profile for V1 recipes.
2. Expose English, multilingual, and auto-routing as advanced profiles, not invisible behavior.
3. Display the actual checkpoint used for every result.
4. Return warnings for truncation, large choice sets, and weak/uncalibrated confidence.
5. Treat confidence thresholds as review policies, not proof of correctness.
6. Never let a low-confidence result silently become an automated action.
7. Keep all Laya-specific behavior behind an adapter because upstream APIs are evolving quickly.

## 6. Architecture

```text
MCP client                         Local browser UI
Claude / Copilot / VS Code         http://127.0.0.1:<port>
          |                                      |
          | stdio                                | HTTP + token
          v                                      v
  local-decision-mcp.exe --------------> Local Decision Service
                                               |
                              +----------------+----------------+
                              |                |                |
                         Recipe store     Model manager    History store
                         YAML files       local cache      SQLite, opt-in
                              |                |                |
                              +----------------+----------------+
                                               |
                                           LayaAdapter
                                               |
                                        installed Laya package
                                               |
                                      local checkpoint weights
```

### Architecture rules

- The backend owns recipes, models, policy evaluation, history, and Laya lifecycle.
- The web UI is a client of the same documented API used by tests.
- The MCP process is a thin stdio-to-local-API bridge. It must not load a second model into memory.
- If the service is not running, the MCP bridge may start it and wait for health readiness.
- The adapter is the only module allowed to import `laya`.
- Domain models must not expose upstream implementation objects.
- The backend must remain useful without the UI and without MCP.
- No component listens on a LAN interface in V1.

## 7. Recommended technology choices

### Backend and runtime

- Python 3.12.
- `uv` for developer dependency and lockfile management.
- FastAPI for the localhost API.
- Pydantic v2 for request, result, configuration, and recipe validation.
- PyYAML or `ruamel.yaml` for recipe serialization. Prefer `ruamel.yaml` if preserving user comments becomes a requirement.
- SQLite from the standard library for optional history and app metadata.
- Official MCP Python SDK if its stable API supports the required stdio tools; otherwise isolate the MCP transport behind its own module and pin the chosen SDK version.

### Frontend

- React, TypeScript, and Vite.
- Static assets built at release time and served by FastAPI.
- No external CDN assets, analytics, fonts, or runtime web dependencies.
- Keep the first UI functional and compact; do not build a design system.

### Windows packaging

- PyInstaller `--onedir`, not `--onefile`, for the Python service and MCP launcher.
- An Inno Setup installer that installs the compiled application, shortcuts, licenses, and uninstaller.
- Model weights are not bundled; download them during first-run setup.
- Store mutable state under `%LOCALAPPDATA%/<project-slug>/` and never under the installation directory.
- Do not require administrator access unless testing proves a specific installer step cannot be user-scoped.

The packaging choice must be validated in an early spike. PyTorch/model dependencies can make packaging unexpectedly large or brittle; do not defer this validation until the end.

## 8. Repository structure

Create a new repository from an empty directory with `git init`. Do not clone Laya, remove `.git`, or add the Laya repository as an upstream remote.

```text
local-decision-hub/
├── .github/
│   └── workflows/
├── backend/
│   ├── src/local_decision_hub/
│   │   ├── api/
│   │   ├── domain/
│   │   ├── laya_adapter/
│   │   ├── models/
│   │   ├── recipes/
│   │   ├── security/
│   │   ├── history/
│   │   ├── lifecycle/
│   │   └── settings.py
│   └── tests/
├── frontend/
│   ├── src/
│   └── tests/
├── mcp/
│   ├── src/
│   └── tests/
├── packaging/
│   └── windows/
├── recipes/
│   └── examples/
├── docs/
│   ├── architecture/
│   ├── integrations/
│   ├── privacy.md
│   └── model-limitations.md
├── scripts/
│   └── verify.py
├── THIRD_PARTY_NOTICES.md
├── LICENSE
├── README.md
├── SECURITY.md
├── CONTRIBUTING.md
├── pyproject.toml
├── uv.lock
└── package-lock.json
```

Use one Python project unless packaging demonstrates that separate backend and MCP project environments are necessary. Centralize the working product name, executable names, package slug, application-data directory, and protocol version so renaming the product does not require a repository-wide edit.

## 9. Stable domain contracts

### 9.1 Recipe format

Use a product-owned schema rather than exposing Laya's current Python dictionary structure as the public contract.

```yaml
schema_version: 1
id: email-triage
name: Email triage
description: Routes incoming messages and estimates urgency.
model_profile: typed-decisions

questions:
  department:
    type: choice
    instructions: Which department should handle this request?
    criteria:
      sales: Pricing, proposals, and new contracts
      finance: Invoices, payments, and refunds
      support: Product problems and technical help
      other: Anything that does not fit the other categories

  urgent:
    type: noul
    instructions: Does this require urgent human attention?

  priority:
    type: score
    instructions: How important is this request?
    criteria:
      - low
      - normal
      - high
      - critical

review_policy:
  default_min_confidence: 0.80
  on_low_confidence: needs_review
```

Validation rules:

- `schema_version` is required and must currently equal `1`.
- `id` is lowercase kebab-case, unique, and cannot contain path separators.
- Recipe and question display names have bounded lengths.
- Question IDs are unique and stable.
- `choice` has 2–20 options in the normal V1 path. Allow 21–50 only with a prominent validation warning; reject more than 50 in V1.
- `choice.criteria` is a non-empty mapping of stable machine keys to clear descriptions.
- `score.criteria` is an ordered list with at least two levels.
- `noul` is a probability-like true/false judgment and needs no criteria.
- Instructions and criteria have bounded lengths.
- Unknown fields are rejected so typos do not silently change behavior.
- YAML parsing must use safe loading and must reject aliases or structures capable of resource-exhaustion attacks.
- A recipe cannot contain executable code, templates, URLs to fetch, environment-variable expansion, or filesystem paths.

### 9.2 Decision input

Accept either:

- plain text, normalized to `{"text": "..."}`; or
- a JSON object with bounded depth, field count, and serialized size.

Do not accept file paths, URLs, or arbitrary attachments in V1. This keeps the trust boundary simple and prevents an MCP caller from turning the product into a local file reader or network fetcher.

### 9.3 Decision result

Return a stable product-owned envelope:

```json
{
  "request_id": "uuid",
  "recipe_id": "email-triage",
  "status": "completed",
  "review": "needs_review",
  "model": {
    "profile": "typed-decisions",
    "checkpoint": "resolved checkpoint identifier",
    "revision": "pinned revision",
    "device": "cpu"
  },
  "answers": {},
  "warnings": [],
  "timing_ms": 184.2,
  "contract_version": 1
}
```

Normalize each primitive into a documented answer type while retaining upstream distributions when available. The adapter must tolerate missing optional upstream fields and raise an explicit compatibility error for incompatible required fields.

`review` is derived from the configured policy and warnings. It is not an assertion that the model output is correct.

## 10. Local API

Use `/v1` from the first release.

Required endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health/live` | Process is running; never loads a model. |
| GET | `/health/ready` | Required configuration and selected model are ready. |
| GET | `/v1/status` | App version, offline readiness, model status, and safe diagnostics. |
| GET | `/v1/models` | Installed and supported model profiles. |
| POST | `/v1/models/{profile}/download` | Start an explicit model download. |
| DELETE | `/v1/models/{profile}` | Remove local model files after explicit confirmation. |
| GET | `/v1/recipes` | List recipe metadata. |
| POST | `/v1/recipes` | Validate and create a recipe. |
| GET | `/v1/recipes/{id}` | Read a recipe. |
| PUT | `/v1/recipes/{id}` | Validate and replace a recipe. |
| DELETE | `/v1/recipes/{id}` | Delete a recipe after confirmation. |
| POST | `/v1/recipes/validate` | Validate without saving. |
| POST | `/v1/decisions` | Run one recipe against text or JSON state. |
| GET | `/v1/history` | Read local history only when enabled. |

Implementation rules:

- Set a bounded request size, initially 256 KiB.
- Run model inference off the async event loop.
- Start with a single inference worker and a bounded queue to avoid memory duplication.
- Return `429` with a retry hint when the queue is full.
- Model loading must be serialized and observable through status.
- Use explicit timeouts and cancellation behavior.
- OpenAPI may be enabled in development but should be disabled in production builds unless a local advanced setting enables it.

## 11. Laya adapter

Define a protocol such as:

```python
class DecisionEngine(Protocol):
    def ensure_model(self, profile: ModelProfile) -> ModelInfo: ...
    def predict(self, state: dict[str, object], recipe: Recipe) -> DecisionResult: ...
    def unload(self) -> None: ...
```

The concrete `LayaAdapter` must:

- be the only place that imports Laya;
- translate product recipes into the current Laya question schema;
- select the requested checkpoint explicitly;
- resolve and report the actual checkpoint and pinned revision;
- cache one loaded model by default;
- normalize output into the product result contract;
- identify truncation where upstream exposes enough information, or conservatively warn when input exceeds the known profile budget;
- warn on high-cardinality choices and advanced routing;
- convert upstream exceptions into stable application errors;
- expose no arbitrary Python execution surface;
- include contract tests against a fake engine and separate opt-in tests against real downloaded weights.

Pin the Laya package version. Do not rely on an unpinned Git branch. Create an explicit compatibility matrix in `docs/architecture/laya-compatibility.md` containing:

- product version;
- supported Laya version;
- supported model identifiers and revisions;
- expected fields for each primitive;
- known limitations;
- date last verified.

## 12. Model management

The first-run flow must explain download size, expected disk usage, network requirement, and offline behavior before starting a download.

Requirements:

- Download only after an explicit user action.
- Pin model repository and immutable revision/commit.
- Verify downloaded files using trusted metadata or recorded hashes where practical.
- Support resume and clear failure recovery.
- Never execute code from a model repository. Set model-loading options equivalent to `trust_remote_code=False` wherever supported.
- Store models only inside the application data directory or a user-selected directory.
- Show installed revision, size, last verified time, and active profile.
- Allow removal without uninstalling the app.
- Do not download real weights in ordinary unit tests or pull-request CI.

Recommended V1 profiles:

| Profile | Default role | UI treatment |
| --- | --- | --- |
| `typed-decisions` | Organizational recipes | Recommended/default |
| `english` | General English classification | Advanced |
| `multilingual` | Non-English input | Advanced with calibration warning |
| `auto` | Laya router | Experimental/advanced |

Do not finalize distribution rights based only on the Python repository's Apache-2.0 license. Before release, independently verify and record the license and redistribution terms for every model checkpoint and bundled binary dependency.

## 13. MCP interface

Ship one executable, for example `local-decision-mcp.exe`, which communicates over stdio with the host and calls the localhost service.

MCP tools:

| Tool | Mutation | Behavior |
| --- | --- | --- |
| `list_recipes` | No | Returns recipe IDs, names, descriptions, and model profiles. |
| `get_recipe` | No | Returns one normalized recipe. |
| `validate_recipe` | No | Validates proposed YAML/JSON and returns actionable issues. |
| `run_decision` | No | Runs a named recipe against explicit text or JSON supplied by the caller. |
| `save_recipe` | Yes | Creates or updates a recipe only after the MCP host presents normal write approval. |
| `delete_recipe` | Yes | Optional for V1; require explicit approval and exact recipe ID. |

MCP requirements:

- Write protocol messages only to stdout; send logs to stderr.
- Do not accept arbitrary file paths or URLs.
- Do not expose a generic shell, Python, HTTP proxy, or filesystem tool.
- Keep tool descriptions explicit about local processing and mutations.
- If the service is stopped, start the installed backend using an argument array without a shell, then poll readiness with a short bounded timeout.
- Reuse the same local authorization token as the UI client.
- Return compact structured errors instead of Python tracebacks.
- Provide a `--print-config <client>` command that prints or writes the correct client configuration using the installed absolute executable path.
- Never silently edit third-party client configuration. Offer a generated snippet or require a separate explicit setup action.

The AI-client integration is useful even though the client itself may be cloud-hosted. Documentation must repeat that distinction.

## 14. User interface

V1 needs five screens:

1. **Setup** — app readiness, model selection, download progress, offline-ready state.
2. **Try a decision** — select recipe, paste text/JSON, run, inspect answers, distributions, review state, warnings, checkpoint, and latency.
3. **Recipes** — list, create, edit, duplicate, import, export, validate, and delete.
4. **Connections** — client-specific MCP setup instructions and generated config.
5. **Settings** — data directory, history opt-in, diagnostics, app version, dependency notices, and model removal.

UX rules:

- Use plain organizational language before model terminology.
- Always display `needs review` separately from raw probability.
- Do not use green/red alone to communicate status.
- Warn before running recipes with many options or inputs likely to truncate.
- Show where data is processed and whether the model is locally ready.
- Never imply that connecting an external AI client makes the whole workflow offline.
- Include example recipes for email triage, support routing, document review, and sales lead categorization.
- Example recipes must be clearly labeled as demonstrations, not production-validated policies.

## 15. Security and privacy baseline

- Bind only to `127.0.0.1`; reject configuration attempts to use `0.0.0.0` in V1.
- Generate a random per-install bearer token and store it with current-user-only permissions.
- Validate `Host` and `Origin` headers to reduce localhost browser and DNS-rebinding attacks.
- Use restrictive CORS. The served UI origin and non-browser local MCP client are the only intended consumers.
- Add a Content Security Policy and bundle all frontend assets locally.
- Never log request bodies, recipe input content, tokens, or full decision outputs.
- Give every log event a safe request ID and error code.
- Keep history disabled by default. If enabled, explain exactly what is stored and provide `clear history`.
- Parse YAML safely with resource limits.
- Prevent path traversal by mapping validated recipe IDs to paths; do not accept caller-supplied paths.
- Use subprocess argument arrays with `shell=False`.
- Pin dependencies and model revisions. Produce a software bill of materials for releases.
- Run dependency, secret, and static security scans in CI.
- Document a vulnerability-reporting process in `SECURITY.md`.
- Do not collect telemetry in V1.

## 16. Licensing and attribution

Default this new project to Apache-2.0 unless the repository owner chooses another compatible license before the first commit. The product license need not match Laya merely because Laya is a dependency, but Apache-2.0 is a clean default for this open-source project.

Required repository and distribution work:

- Add the project's own `LICENSE`.
- Add `THIRD_PARTY_NOTICES.md` naming Laya, Convai Innovations, its source repository, pinned package version, and Apache-2.0 license.
- Include the required Laya license text and notices in binary distributions when redistributing Laya code.
- Inventory all Python, JavaScript, installer, and model licenses.
- Include a notice/licenses view in the application.
- Credit Laya prominently in the README without implying endorsement or official affiliation.
- Use wording such as: `Powered by Laya, an open-source System 1 decision model developed by Convai Innovations.`
- Verify checkpoint licenses separately before redistributing or automatically downloading weights.
- Do not use Laya branding as the product name.

This section is an engineering checklist, not legal advice. Escalate ambiguous redistribution or trademark terms before release.

## 17. Implementation order

Complete tasks in this order. Each task must leave the repository passing `py scripts/verify.py` (or the platform-equivalent Python launcher). Commit after every task with a focused commit message. Do not weaken, delete, or skip tests to make a task pass.

### Phase 0 — Repository and packaging risk spike

#### Task 0.1: Create the independent repository

- Initialize a new Git repository in an empty directory.
- Add base documentation, Apache-2.0 project license, notices skeleton, editor settings, ignore rules, and contribution/security files.
- Do not add the Laya Git repository as a remote or copy its source.
- Record Laya only as an upstream dependency and attribution.

Acceptance criteria:

- `git remote -v` contains only the new project remote, if configured.
- Git history begins with this project.
- README states that the project is independent and powered by Laya.

#### Task 0.2: Capture upstream compatibility

- Pin a known Laya package version.
- Record model identifiers, immutable revisions, licenses, expected download sizes, and required output fields.
- Write a minimal script that loads the recommended checkpoint and runs one example of each primitive.
- Save normalized fixture outputs with sensitive or machine-specific data removed.

Acceptance criteria:

- All three primitive examples run on a development machine with downloaded weights.
- The compatibility document contains no unresolved placeholder for the package version or checkpoint revision.
- Model license status is explicitly `verified` or a release blocker.

#### Task 0.3: Prove Windows packaging early

- Package a minimal Laya-backed executable with PyInstaller `--onedir` on Windows CI.
- Start it, run a smoke decision using a CI-safe fake engine by default, and verify uninstall layout.
- Run a separate manual or scheduled real-model packaging test.
- Record installed size, cold-start time, model-load time, and first-decision latency.

Acceptance criteria:

- The executable runs on a clean Windows 11 VM without system Python.
- A packaged build can locate its bundled application files and user-writable data directory.
- If PyInstaller is not viable, stop and document evidence before selecting another packager.

### Phase 1 — Domain core

#### Task 1.1: Implement versioned domain models

- Implement recipe, question, policy, model, decision input, result, warning, and error models.
- Implement strict validation rules from this plan.
- Add stable JSON serialization fixtures.

Acceptance criteria:

- Unit tests cover all primitives, invalid IDs, unknown fields, oversized content, option limits, and schema-version errors.
- Domain tests do not import Laya or FastAPI.

#### Task 1.2: Implement recipe storage

- Store one YAML file per recipe in the app data directory.
- Use atomic writes: write and fsync a temporary file, then replace.
- Prevent traversal and symlink escapes.
- Add create/read/update/delete/list/import/export operations.
- Seed examples on first run without overwriting user edits.

Acceptance criteria:

- Concurrent or interrupted writes cannot leave a partially written recipe as valid.
- Malicious IDs and symlinks cannot escape the recipe directory.
- Round-trip tests preserve the product schema.

### Phase 2 — Decision engine

#### Task 2.1: Implement fake engine and service contract

- Implement a deterministic fake `DecisionEngine` for tests and UI development.
- Implement policy evaluation and normalized warnings without depending on Laya.

Acceptance criteria:

- All service-level tests run without network access or model downloads.
- Fake results exercise completed, low-confidence, warning, and failure states.

#### Task 2.2: Implement `LayaAdapter`

- Translate each domain primitive to the pinned Laya API.
- Load and cache the selected checkpoint.
- Normalize results and errors.
- Add conservative warnings for context and choice limits.
- Add opt-in real-model integration tests.

Acceptance criteria:

- No module outside `laya_adapter` imports Laya.
- Contract tests pass for all three primitives.
- A dependency or output mismatch produces a clear compatibility error rather than corrupt output.

#### Task 2.3: Implement model manager

- Add status, download, resume, verify, select, and remove operations.
- Prevent code execution from downloaded model repositories.
- Add model locking so two processes cannot download or mutate the same profile concurrently.

Acceptance criteria:

- Interrupted downloads recover safely.
- Offline-ready status is accurate.
- Unit tests use a local fake artifact source; CI does not contact Hugging Face.

### Phase 3 — Local service

#### Task 3.1: Implement the FastAPI service

- Add the endpoints in this plan.
- Add bearer-token auth, request limits, host/origin validation, bounded inference queue, and safe errors.
- Serve the API on an automatically selected stable local port recorded in app state.

Acceptance criteria:

- Requests without the token fail.
- Requests from disallowed hosts/origins fail.
- The service cannot bind to a non-loopback interface in production mode.
- Queue saturation returns a controlled `429`.
- API tests use the fake engine and require no model download.

#### Task 3.2: Implement lifecycle and single-instance behavior

- Ensure only one backend owns the model and local state.
- Implement process startup, readiness polling, clean shutdown, crash recovery, and stale-lock handling.
- Ensure the MCP launcher and UI discover the same endpoint and token.

Acceptance criteria:

- Starting a second service reuses or reports the first instance instead of loading another model.
- Closing the browser UI does not unexpectedly kill an active MCP service.
- Stale process metadata recovers safely after a crash.

### Phase 4 — MCP

#### Task 4.1: Implement the stdio MCP bridge

- Add the tools listed in this plan.
- Keep stdout protocol-clean.
- Auto-start the backend when appropriate.
- Add explicit mutation metadata/descriptions for recipe writes.

Acceptance criteria:

- An MCP inspector can list and invoke every tool.
- `run_decision` uses the already-running backend and does not load another model.
- Invalid input returns a structured tool error.
- Paths and URLs are rejected as decision sources.

#### Task 4.2: Add client configuration generation

- Generate config snippets for Claude Desktop and VS Code/GitHub Copilot using the installed executable path.
- Add docs for Claude Code and OpenCode if their current configuration can be verified.
- Include removal/uninstall instructions.

Acceptance criteria:

- Each documented client passes a manual end-to-end smoke test.
- Generated JSON is valid and contains no development-only path.
- The setup does not silently overwrite a user's existing client configuration.

### Phase 5 — Local UI

#### Task 5.1: Build setup and status screens

- Implement first-run model selection, consented download, progress, errors, retry, and offline-ready state.
- Add safe diagnostics copy/export without secrets or user inputs.

Acceptance criteria:

- A first-time user can reach a ready state without reading developer documentation.
- Restarting during a download has a clear recovery path.

#### Task 5.2: Build recipe and decision screens

- Implement the five V1 screens.
- Provide form-based recipe editing; YAML import/export is secondary.
- Render primitive-specific results and full warnings.

Acceptance criteria:

- Every recipe feature works through the API rather than direct filesystem access.
- The UI clearly distinguishes confidence, review policy, and warnings.
- Keyboard navigation and color-independent status presentation pass accessibility checks.

### Phase 6 — Installer and release hardening

#### Task 6.1: Produce the Windows installer

- Build signed-ready `--onedir` artifacts and an Inno Setup installer.
- Install current-user shortcuts, MCP executable, notices, and uninstaller.
- Preserve user recipes by default during upgrades and uninstall unless the user explicitly chooses data removal.

Acceptance criteria:

- Clean install, upgrade, repair, and uninstall are tested on a clean Windows 11 VM.
- No administrator prompt is required for the default user-scoped install.
- Uninstall clearly distinguishes program files from user-created recipes and downloaded models.

#### Task 6.2: Complete security, privacy, and license review

- Run static analysis, dependency audit, secret scan, SBOM generation, localhost attack tests, and license inventory.
- Verify checkpoint redistribution/download terms.
- Review all user-facing privacy claims.

Acceptance criteria:

- No unresolved critical/high security finding.
- Every shipped dependency and model has a recorded license disposition.
- No request body or secret appears in production logs.
- Release notes state known model limitations.

#### Task 6.3: Run the non-developer usability test

- Give a clean Windows laptop/VM and installer to a person who has not used Laya.
- Do not provide verbal developer guidance.
- Observe install, first decision, recipe creation, and one MCP connection.

Acceptance criteria:

- First local decision in five minutes.
- First MCP decision in ten total minutes.
- Any repeated confusion becomes a product or documentation issue before release.

## 18. Test strategy

### Required automated layers

- Domain unit tests.
- Recipe parser and malicious-input tests.
- Adapter contract tests with captured fixtures.
- Optional real-model integration tests.
- API tests with fake engine.
- MCP protocol and stdout-cleanliness tests.
- Frontend unit and accessibility tests.
- Browser end-to-end tests against fake engine.
- Windows packaged smoke tests.
- Upgrade/uninstall tests.
- Security regression tests for auth, Host/Origin, traversal, YAML, request size, and logging.

### One verification command

Create `scripts/verify.py` as the supported local and CI entry point. It must fail fast with a useful summary and run, in order:

1. formatting checks;
2. Python lint and type checks;
3. Python tests and coverage threshold;
4. frontend lint, type check, tests, and production build;
5. generated-contract drift checks;
6. secret and dependency-policy checks that are practical offline.

Real-model tests and Windows packaging tests must use explicit flags because of runtime and download cost, for example:

```text
py scripts/verify.py
py scripts/verify.py --real-model
py scripts/verify.py --package-windows
```

The coding agent must not modify the verification script to omit an existing check unless the task explicitly changes the project's quality policy.

## 19. CI and release flow

Pull requests:

- run the ordinary verification command on Linux and Windows;
- build the frontend;
- run fake-engine API and MCP integration tests;
- run dependency, secret, and static security scans;
- never download full model weights.

Main/nightly:

- run a real-model compatibility test on a controlled runner with cached weights;
- build the Windows package;
- smoke-test the installed binaries;
- publish test artifacts only for trusted branches.

Release:

- tag an exact source commit;
- use locked dependencies and pinned model metadata;
- produce checksums and an SBOM;
- include project license and third-party notices;
- attach an installer and portable diagnostic bundle if needed;
- publish known limitations and compatibility matrix;
- do not claim code signing until binaries are actually signed and verified.

## 20. Observability and diagnostics

Record only operational metadata by default:

- app and component version;
- startup and shutdown events;
- selected model profile and revision;
- model download/load state;
- request ID, duration, result status, and safe error code;
- queue depth and memory diagnostics when explicitly requested.

Never log:

- decision input;
- recipe instructions or criteria by default;
- decision answers;
- bearer tokens;
- MCP protocol payloads;
- model-download credentials.

Diagnostics export must be human-readable and previewable before saving.

## 21. Documentation deliverables

The repository is not complete without:

- a plain-language README with screenshots and a two-minute quick start;
- architecture and trust-boundary documentation;
- model limitations and confidence guidance;
- recipe authoring guide with good and bad examples;
- local/offline versus external-AI privacy explanation;
- Claude Desktop and Copilot/VS Code MCP setup guides;
- troubleshooting for model download, antivirus, memory pressure, and client config;
- uninstall and data-removal instructions;
- Laya compatibility matrix;
- third-party notices and security policy.

## 22. Definition of done for V1

V1 is done only when all of the following are true:

- The repository has no Git or source-copy relationship to the Laya repository.
- A clean Windows 11 machine needs no preinstalled developer tools.
- Installation and uninstall are user-scoped and reliable.
- At least one recommended model can be downloaded, verified, loaded, and reused offline.
- All three decision primitives work through UI, REST, and MCP.
- Recipes are strict, versioned, portable, and safely stored.
- Low-confidence and model-limit warnings are visible in all interfaces.
- The backend is loopback-only and locally authenticated.
- MCP cannot read local files or fetch URLs through decision inputs.
- History is disabled by default and production logs contain no decision content.
- Claude Desktop and VS Code/GitHub Copilot integrations pass documented smoke tests.
- A non-developer completes the target first-run flow within the time budget.
- Verification, packaged smoke tests, security review, license inventory, SBOM, attribution, and checkpoint-license review all pass.

## 23. Rules for the coding agent

1. Follow the task order; the packaging spike is intentionally early.
2. Keep changes scoped to one task and commit after each completed task.
3. Run `py scripts/verify.py` before every commit once the script exists.
4. Never weaken or delete a test merely to obtain a passing build.
5. Never copy Laya source into this repository unless the owner explicitly approves a new legal and architectural plan.
6. Never expose the service beyond loopback.
7. Never add telemetry, cloud inference, file-reading tools, remote connectors, or automatic actions without explicit scope approval.
8. Keep upstream-specific code inside `laya_adapter`.
9. Pin dependencies and model revisions; do not use floating Git branches or model revisions.
10. Do not make performance, accuracy, calibration, privacy, offline, or security claims that tests and architecture do not support.
11. When an upstream mismatch is found, add a failing compatibility test, document the evidence, and fix the adapter. Do not leak the mismatch into the public recipe or result contracts.
12. Stop and ask for a product decision when a change would alter the trust boundary, license obligations, persistence defaults, or V1 non-goals.

## 24. Decisions deliberately deferred

- Final product name and visual identity.
- macOS/Linux packaging.
- Supported GPU backends.
- Domain-specific fine-tuning workflow.
- Signed automatic updates.
- Organization-wide deployment and policy management.
- Connectors that ingest documents directly.
- Remote API mode.
- Production automation based on decisions.

These are post-V1 decisions and must not block the local Windows MVP.

## 25. Primary upstream references

- Laya repository and current README: <https://github.com/NandhaKishorM/laya>
- Laya license: <https://github.com/NandhaKishorM/laya/blob/main/LICENSE>
- Laya package metadata: <https://github.com/NandhaKishorM/laya/blob/main/pyproject.toml>
- Model collection linked by upstream: <https://huggingface.co/convaiinnovations/laya>

Re-check these references and record exact versions/revisions during Task 0.2. The repository is moving quickly; this plan intentionally treats the adapter and compatibility matrix as release-critical boundaries.
