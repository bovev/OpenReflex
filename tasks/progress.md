# Current task

- Task: `task-02-frontend-foundation.md`
- Round: 4
- Baseline: `4404f3f31decdc499d2f633231d4eb7df3889b60`
- Stage: accepted
- Blocking review finding: encoded or mixed-form dot segments can normalize outside `/v1` before fetch.
- Blocking review finding: the frontend API client accepts external absolute or protocol-relative URLs and could forward the bearer token off-origin.
- Replan: use pinned `@rollup/wasm-node` override so verification runs under Windows Application Control.
