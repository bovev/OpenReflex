import { defineConfig } from "@playwright/test";

// The suite drives a real loopback service (scripts/fake_service.py) with the
// deterministic fake engine and an in-memory artifact source. One service per
// worker, one worker: the service is stateful (downloads, history, deletes)
// and the tests must observe a single, ordered history of requests.
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    viewport: { width: 1280, height: 900 },
    // The UI copies generated snippets and diagnostics to the clipboard on an
    // explicit user action; the tests verify those writes.
    permissions: ["clipboard-read", "clipboard-write"],
  },
});
