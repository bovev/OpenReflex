---
task: 2
status: blocked
depends_on: [1]
rework_rounds: 1
replanned_at: ebf1874
---

# Establish the local frontend foundation

## Goal
Create the React, TypeScript, and Vite frontend foundation, including secure token bootstrap, an authenticated API client, and a compact shell for the five V1 screens.

## Scope
`frontend/`, root npm workspace files, frontend-related verification configuration, FastAPI static-asset serving, and focused backend/frontend tests. Screen-specific workflows remain out of scope.

## Do
- Add a pinned npm workspace for React, TypeScript, Vite, linting, type checking, unit tests, and production builds; commit the lockfile. Configure the root npm `overrides` to resolve `rollup` as the exact-version drop-in alias `npm:@rollup/wasm-node@4.63.4` (which satisfies Vite's `^4.43.0` range), so Vite and Vitest do not load a native `.node` binding. The lockfile must resolve that replacement consistently and must not contain a Windows native Rollup package.
- Build a compact app shell with keyboard-accessible navigation for Setup, Try a decision, Recipes, Connections, and Settings. Placeholder screen bodies are sufficient in this task.
- Bootstrap the bearer token only from the URL fragment produced by `openreflex-service open`. Remove it from the visible URL with `history.replaceState`, retain it only for the browser tab (not `localStorage`), and never render or log it.
- Add a same-origin API client that sends the bearer token, handles product error envelopes and request IDs, supports cancellation, and never retries mutations implicitly.
- Present a clear recovery state when the token is missing or rejected, with instructions to relaunch through OpenReflex.
- Serve the production build through FastAPI with local assets only. Keep the existing CSP free of `unsafe-inline`, external origins, CDNs, analytics, and remote fonts.
- Ensure cache behavior does not retain authenticated API responses or the application bootstrap document.
- Add unit tests for token extraction/removal, tab-scoped storage, auth headers, safe error rendering, cancellation, and navigation semantics.
- Wire frontend lint, typecheck, test, and build into the existing supported verification flow without removing or skipping any check.

## Acceptance criteria
- [ ] `npm install` at the repository root installs the frontend workspace from the committed lockfile.
- [ ] The installed Vite/Vitest dependency graph uses pinned `@rollup/wasm-node` in place of native Rollup; `npm run --workspace frontend test` and `npm run --workspace frontend build` run under Windows Application Control without loading `rollup.win32-x64-msvc.node`.
- [ ] A production build is served at `/` and its assets load under the existing CSP without external runtime requests.
- [ ] The token never appears in query parameters, rendered content, logs, `localStorage`, or API error text.
- [ ] All five screen names are reachable by keyboard and have a unique heading and active-navigation state.
- [ ] Missing and invalid token states are understandable without exposing credentials.
- [ ] `py scripts/verify.py` passes, including frontend lint, typecheck, tests, and build.

## Out of scope
- Model download controls, recipe editing, decision execution, connection setup content, or settings mutations.
- A reusable design system or visual-branding project.
- Browser end-to-end coverage, which is added in a later task.
