import { describe, expect, it } from "vitest";
import {
  buildDiagnostics,
  DATA_DIR_LABEL,
  renderDiagnostics,
} from "../src/diagnostics";
import type { ModelStatus, StatusReport } from "../src/types";

const TOKEN = "tok-diag-secret-123";
const DATA_DIR = "C:\\Users\\someone\\AppData\\Local\\OpenReflex";
const REVISION = "1c5edc17a7acd8701df6fc341c0d179f1c62c982";

function modelFixture(
  overrides: Partial<ModelStatus> & { profile: ModelStatus["profile"] },
): ModelStatus {
  return {
    checkpoint: "convaiinnovations/laya",
    revision: REVISION,
    state: "not_installed",
    download_bytes: 842609220,
    disk_bytes: 0,
    verified_at: null,
    progress: null,
    last_error: null,
    ...overrides,
  };
}

function statusFixture(overrides: Partial<StatusReport> = {}): StatusReport {
  return {
    product: "OpenReflex",
    version: "0.1.0",
    contract_version: 1,
    attribution:
      "Powered by Laya, an open-source System 1 decision model developed by Convai Innovations.",
    offline_ready: false,
    default_profile: "typed-decisions",
    engine: { engine: "fake", loaded_profile: null, loaded_checkpoint: null },
    models: [
      modelFixture({ profile: "typed-decisions" }),
      modelFixture({ profile: "english" }),
      modelFixture({ profile: "multilingual" }),
    ],
    queue_depth: 0,
    queue_capacity: 16,
    history: { enabled: false, what_is_stored: "decision inputs, outputs, and timestamps" },
    data_dir: DATA_DIR,
    ...overrides,
  };
}

describe("safe diagnostics", () => {
  it("includes the allowlisted operational versions and model states", () => {
    const text = renderDiagnostics(
      buildDiagnostics(
        statusFixture({
          offline_ready: true,
          engine: {
            engine: "fake",
            loaded_profile: "typed-decisions",
            loaded_checkpoint: "convaiinnovations/laya/typed-decisions",
          },
          models: [
            modelFixture({
              profile: "typed-decisions",
              state: "installed",
              disk_bytes: 842609220,
              verified_at: "2026-01-01T00:00:00+00:00",
            }),
            modelFixture({
              profile: "english",
              state: "downloading",
              progress: {
                done_bytes: 1000,
                total_bytes: 842609210,
                current_file: "model.safetensors",
              },
              last_error: null,
            }),
            modelFixture({
              profile: "multilingual",
              state: "damaged",
              last_error:
                "model.safetensors failed verification and was discarded; try again",
            }),
          ],
        }),
        true,
      ),
    );
    expect(text).toContain("OpenReflex diagnostics");
    expect(text).toContain("name: OpenReflex");
    expect(text).toContain("version: 0.1.0");
    expect(text).toContain("result contract version: 1");
    expect(text).toContain("attribution: Powered by Laya");
    expect(text).toContain("offline ready: yes");
    expect(text).toContain("default profile: typed-decisions");
    expect(text).toContain("inference queue: 0 of 16");
    expect(text).toContain("history: disabled - decision inputs, outputs, and timestamps");
    expect(text).toContain("engine: fake");
    expect(text).toContain("loaded profile: typed-decisions");
    expect(text).toContain("loaded checkpoint: convaiinnovations/laya/typed-decisions");
    expect(text).toContain("typed-decisions: installed");
    expect(text).toContain(`revision: ${REVISION}`);
    expect(text).toContain("842609220 bytes");
    expect(text).toContain("verified at: 2026-01-01T00:00:00+00:00");
    expect(text).toContain("english: downloading");
    expect(text).toContain("progress: 1000 of 842609210 bytes, current file: model.safetensors");
    expect(text).toContain("multilingual: damaged");
    expect(text).toContain(
      "last error: model.safetensors failed verification and was discarded; try again",
    );
  });

  it("replaces the data directory with a fixed label, never the real path", () => {
    const text = renderDiagnostics(buildDiagnostics(statusFixture(), false));
    expect(text).toContain(DATA_DIR_LABEL);
    expect(text).not.toContain(DATA_DIR);
    expect(text).not.toContain("someone");
    expect(text).not.toContain("AppData");
  });

  it("never carries sensitive fields that are present on the payload", () => {
    const raw = {
      ...statusFixture(),
      // Fields that must never reach the diagnostics, even if present.
      token: TOKEN,
      recipes: [{ id: "triage", content: "secret-recipe-content" }],
      history_entries: [
        { input: "secret-decision-input", output: "secret-decision-output" },
      ],
      request_body: "secret-request-body",
      exception:
        'Traceback (most recent call last):\n  File "x.py", line 1\nraw-exception-text',
      home_dir: "C:\\Users\\someone",
    } as unknown as StatusReport;
    const text = renderDiagnostics(buildDiagnostics(raw, false));
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("secret-recipe-content");
    expect(text).not.toContain("secret-decision-input");
    expect(text).not.toContain("secret-decision-output");
    expect(text).not.toContain("secret-request-body");
    expect(text).not.toContain("Traceback");
    expect(text).not.toContain("raw-exception-text");
    expect(text).not.toContain("home_dir");
    expect(text).not.toContain("someone");
    expect(text).not.toContain(DATA_DIR);
  });

  it("is deterministic for a given payload", () => {
    const report = statusFixture();
    expect(renderDiagnostics(buildDiagnostics(report, false))).toBe(
      renderDiagnostics(buildDiagnostics(report, false)),
    );
  });

  it("uses the snapshot-derived readiness, not the payload's stale flag", () => {
    // The payload still carries the initial (stale) flag...
    const text = renderDiagnostics(
      buildDiagnostics(statusFixture({ offline_ready: false }), true),
    );
    // ...but the diagnostics report the readiness derived from the
    // current model snapshot.
    expect(text).toContain("offline ready: yes");
  });
});
