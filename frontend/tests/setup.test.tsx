import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupScreen } from "../src/setup";
import { bootstrapToken, clearToken } from "../src/token";
import type { ModelStatus, StatusReport } from "../src/types";

const TOKEN = "tok-setup-123";
const DATA_DIR = "C:\\Users\\someone\\AppData\\Local\\OpenReflex";
const REVISION = "1c5edc17a7acd8701df6fc341c0d179f1c62c982";

interface StubHeaders {
  get: (name: string) => string | null;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    lower[key.toLowerCase()] = value;
  }
  const headerStub: StubHeaders = { get: (name: string) => lower[name.toLowerCase()] ?? null };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headerStub,
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

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

function setupFetch(handler: (method: string, url: string) => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    return Promise.resolve(handler(method, input));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function callsTo(
  fetchMock: ReturnType<typeof vi.fn>,
  method: string,
  url: string,
): number {
  return fetchMock.mock.calls.filter(
    ([urlArg, init]) =>
      urlArg === url && ((init as RequestInit | undefined)?.method ?? "GET") === method,
  ).length;
}

beforeEach(() => {
  vi.useFakeTimers();
  window.location.hash = `#token=${TOKEN}`;
  bootstrapToken();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearToken();
});

async function renderSetup(): Promise<void> {
  render(<SetupScreen />);
  await vi.waitFor(() => {
    expect(
      screen.queryByTestId("setup") !== null || screen.queryByTestId("setup-error") !== null,
    ).toBe(true);
  });
}

describe("setup screen", () => {
  it("shows the not-installed state with the pre-download explanation, and never starts a download on load, polling, or profile display", async () => {
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/status") {
        return jsonResponse(200, statusFixture());
      }
      if (method === "GET" && url === "/v1/models") {
        return jsonResponse(200, []);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSetup();

    // Service reachability, distinct from offline/model readiness.
    expect(screen.getByTestId("service-reachability").textContent).toContain("Reachable");
    expect(screen.getByTestId("offline-ready").textContent).toContain("No");
    expect(screen.getByTestId("state-typed-decisions").textContent).toBe("Not installed");
    expect(screen.getByTestId("size-typed-decisions").textContent).toBe("803.6 MiB");

    // Recommended vs. advanced vs. experimental presentation.
    expect(screen.getByTestId("profile-typed-decisions").textContent).toContain("Recommended");
    expect(screen.getByTestId("profile-english").textContent).toContain("Advanced");
    expect(screen.getByTestId("profile-multilingual").textContent).toContain("Advanced");
    expect(screen.getByTestId("profile-auto").textContent).toContain("Experimental");
    expect(screen.getByTestId("state-auto").textContent).toBe(
      "Not ready (missing: english, multilingual)",
    );
    expect(screen.getByTestId("auto-detail").textContent).toContain(
      "There is nothing to download for auto itself",
    );

    // Documented limitations: the multilingual calibration warning, without
    // accuracy claims.
    const multilingual = screen.getByTestId("profile-multilingual").textContent ?? "";
    expect(multilingual).toContain("Calibration warning");
    expect(multilingual).toContain("over-confident without domain calibration");
    expect(multilingual).toContain("calibrate thresholds on your own labelled examples");

    // The pre-download explanation: network, size, verification, resumability,
    // offline reuse.
    const pre = screen.getByTestId("pre-download-typed-decisions").textContent ?? "";
    expect(pre).toContain("internet connection");
    expect(pre).toContain("803.6 MiB");
    expect(pre).toContain("pinned hash");
    expect(pre).toContain("resumes from where it stopped");
    expect(pre).toContain("runs offline");

    // No download on load...
    expect(callsTo(fetchMock, "POST", "/v1/models/typed-decisions/download")).toBe(0);
    // ...and none over several polling intervals, and none for the other
    // profiles merely being displayed.
    await vi.advanceTimersByTimeAsync(5000);
    expect(callsTo(fetchMock, "POST", "/v1/models/typed-decisions/download")).toBe(0);
    expect(callsTo(fetchMock, "POST", "/v1/models/english/download")).toBe(0);
    expect(callsTo(fetchMock, "POST", "/v1/models/multilingual/download")).toBe(0);

    // The announced status region carries the same text, not color alone.
    expect(screen.getByTestId("status-live").textContent).toContain(
      "typed-decisions: Not installed",
    );
  });

  it("starts a download only after an explicit button click, then polls and shows completion", async () => {
    let models: ModelStatus[] = [
      modelFixture({ profile: "typed-decisions" }),
      modelFixture({ profile: "english" }),
      modelFixture({ profile: "multilingual" }),
    ];
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/status") {
        return jsonResponse(200, statusFixture({ models }));
      }
      if (method === "GET" && url === "/v1/models") {
        return jsonResponse(200, models);
      }
      if (method === "POST" && url === "/v1/models/typed-decisions/download") {
        models = [
          modelFixture({
            profile: "typed-decisions",
            state: "downloading",
            progress: {
              done_bytes: 1024,
              total_bytes: 842609220,
              current_file: "model.safetensors",
            },
          }),
          modelFixture({ profile: "english" }),
          modelFixture({ profile: "multilingual" }),
        ];
        return jsonResponse(202, models[0]);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSetup();
    expect(callsTo(fetchMock, "POST", "/v1/models/typed-decisions/download")).toBe(0);

    // The explicit action.
    screen.getByTestId("download-typed-decisions").click();
    await vi.waitFor(() => {
      expect(screen.getByTestId("state-typed-decisions").textContent).toBe("Downloading");
    });
    expect(callsTo(fetchMock, "POST", "/v1/models/typed-decisions/download")).toBe(1);

    // Progress: bytes, phase, and an announced progress indicator.
    const bar = screen.getByTestId("progressbar-typed-decisions");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("842609220");
    expect(bar.getAttribute("aria-valuenow")).toBe("1024");
    expect(bar.getAttribute("aria-valuetext")).toContain("model.safetensors");
    expect(screen.getByTestId("phase-typed-decisions").textContent).toContain("model.safetensors");
    expect(screen.getByTestId("status-live").textContent).toContain(
      "typed-decisions: Downloading",
    );

    // Polling observes the server-side download.
    await vi.advanceTimersByTimeAsync(1000);
    expect(callsTo(fetchMock, "GET", "/v1/models")).toBeGreaterThanOrEqual(1);

    // Completion.
    models = [
      modelFixture({
        profile: "typed-decisions",
        state: "installed",
        disk_bytes: 842609220,
        verified_at: "2026-01-01T00:00:00+00:00",
      }),
      modelFixture({ profile: "english" }),
      modelFixture({ profile: "multilingual" }),
    ];
    await vi.waitFor(
      () => {
        expect(screen.getByTestId("state-typed-decisions").textContent).toBe("Installed");
      },
      { timeout: 10000 },
    );
    expect(screen.getByTestId("verified-typed-decisions").textContent).toBe(
      "2026-01-01T00:00:00+00:00",
    );
    expect(screen.getByTestId("phase-typed-decisions").textContent).toContain(
      "complete and verified",
    );
    // Offline readiness follows the model state: the fixture's stale
    // ``offline_ready: false`` must not survive the completion.
    expect(screen.getByTestId("offline-ready").textContent).toContain("Yes");

    // Polling stops once nothing is downloading.
    await vi.advanceTimersByTimeAsync(1000); // let the effect cleanup settle
    const polls = callsTo(fetchMock, "GET", "/v1/models");
    await vi.advanceTimersByTimeAsync(3000);
    expect(callsTo(fetchMock, "GET", "/v1/models")).toBe(polls);
  });

  it("updates the visible readiness and the diagnostics preview together when a download completes (stale offline_ready: false report)", async () => {
    let models: ModelStatus[] = [
      modelFixture({ profile: "typed-decisions" }),
      modelFixture({ profile: "english" }),
      modelFixture({ profile: "multilingual" }),
    ];
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/status") {
        // ``offline_ready`` stays false on the wire throughout the test:
        // only the model snapshot changes.
        return jsonResponse(200, statusFixture({ models }));
      }
      if (method === "GET" && url === "/v1/models") {
        return jsonResponse(200, models);
      }
      if (method === "POST" && url === "/v1/models/typed-decisions/download") {
        models = [
          modelFixture({
            profile: "typed-decisions",
            state: "downloading",
            progress: {
              done_bytes: 100,
              total_bytes: 842609220,
              current_file: null,
            },
          }),
          modelFixture({ profile: "english" }),
          modelFixture({ profile: "multilingual" }),
        ];
        return jsonResponse(202, models[0]);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSetup();
    expect(callsTo(fetchMock, "POST", "/v1/models/typed-decisions/download")).toBe(0);

    // Initially: the visible readiness is "No"...
    expect(screen.getByTestId("offline-ready").textContent).toContain("No");
    // ...and the diagnostics preview agrees.
    screen.getByTestId("diagnostics-toggle").click();
    await vi.waitFor(() =>
      expect(screen.queryByTestId("diagnostics-preview")).toBeTruthy(),
    );
    expect(screen.getByTestId("diagnostics-preview").textContent).toContain(
      "offline ready: no",
    );

    // The explicit download, then completion.
    screen.getByTestId("download-typed-decisions").click();
    await vi.waitFor(
      () => {
        expect(screen.getByTestId("state-typed-decisions").textContent).toBe(
          "Downloading",
        );
      },
      { timeout: 10000 },
    );
    models = [
      modelFixture({
        profile: "typed-decisions",
        state: "installed",
        disk_bytes: 842609220,
        verified_at: "2026-01-01T00:00:00+00:00",
      }),
      modelFixture({ profile: "english" }),
      modelFixture({ profile: "multilingual" }),
    ];
    await vi.waitFor(
      () => {
        expect(screen.getByTestId("state-typed-decisions").textContent).toBe(
          "Installed",
        );
      },
      { timeout: 10000 },
    );

    // The report's initial ``offline_ready`` flag is still false on the
    // wire; both the visible readiness and the diagnostics preview now
    // say yes, from the same current model snapshot.
    expect(screen.getByTestId("offline-ready").textContent).toContain("Yes");
    expect(screen.getByTestId("diagnostics-preview").textContent).toContain(
      "offline ready: yes",
    );
  });

  it("shows a failed poll as temporary unreachability, keeps observing, and restores Reachable without a second download", async () => {
    let pollCount = 0;
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/status") {
        return jsonResponse(200, statusFixture());
      }
      if (method === "GET" && url === "/v1/models") {
        pollCount += 1;
        if (pollCount <= 2) {
          // The service is briefly unreachable (e.g. restarting).
          return jsonResponse(500, {
            code: "internal",
            message: "internal error",
            request_id: "rid-5",
          });
        }
        return jsonResponse(
          200,
          [
            modelFixture({
              profile: "typed-decisions",
              state: "installed",
              disk_bytes: 842609220,
              verified_at: "2026-01-01T00:00:00+00:00",
            }),
          ],
        );
      }
      if (method === "POST" && url === "/v1/models/typed-decisions/download") {
        return jsonResponse(
          202,
          modelFixture({
            profile: "typed-decisions",
            state: "downloading",
            progress: {
              done_bytes: 100,
              total_bytes: 842609220,
              current_file: "model.safetensors",
            },
          }),
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSetup();

    // The explicit download.
    screen.getByTestId("download-typed-decisions").click();
    await vi.waitFor(
      () => {
        expect(screen.getByTestId("state-typed-decisions").textContent).toBe(
          "Downloading",
        );
      },
      { timeout: 10000 },
    );
    expect(callsTo(fetchMock, "POST", "/v1/models/typed-decisions/download")).toBe(1);

    // A failed poll: temporary unreachability is shown...
    await vi.waitFor(
      () => {
        expect(screen.getByTestId("service-reachability").textContent).toContain(
          "Temporarily unreachable",
        );
      },
      { timeout: 10000 },
    );
    // ...the last model details are retained...
    expect(screen.getByTestId("state-typed-decisions").textContent).toBe(
      "Downloading",
    );
    // ...and observation continues (a second poll also fails).
    await vi.waitFor(() => expect(pollCount).toBeGreaterThanOrEqual(2), {
      timeout: 10000,
    });
    expect(screen.getByTestId("service-reachability").textContent).toContain(
      "Temporarily unreachable",
    );

    // The next successful poll restores Reachable and updates the model
    // state, without starting another download.
    await vi.waitFor(
      () => {
        expect(screen.getByTestId("service-reachability").textContent).toContain(
          "Reachable",
        );
      },
      { timeout: 10000 },
    );
    expect(screen.getByTestId("state-typed-decisions").textContent).toBe("Installed");
    expect(pollCount).toBeGreaterThanOrEqual(3);
    expect(callsTo(fetchMock, "POST", "/v1/models/typed-decisions/download")).toBe(1);
  });

  it("serializes polling: a slow poll that fails after its window does not strand the screen unreachable, and starts no second download", async () => {
    let pollCount = 0;
    // The first poll stays pending until we reject it (a service blip).
    let rejectFirstPoll: (error: unknown) => void = () => undefined;
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/status") {
        return jsonResponse(200, statusFixture());
      }
      if (method === "GET" && url === "/v1/models") {
        pollCount += 1;
        if (pollCount === 1) {
          // The first poll is slow and will fail (a service blip).
          return new Promise<unknown>((_resolve, reject) => {
            rejectFirstPoll = reject;
          }) as unknown as Response;
        }
        // Every later poll succeeds with the terminal (installed) state.
        return jsonResponse(
          200,
          [
            modelFixture({
              profile: "typed-decisions",
              state: "installed",
              disk_bytes: 842609220,
              verified_at: "2026-01-01T00:00:00+00:00",
            }),
          ],
        );
      }
      if (method === "POST" && url === "/v1/models/typed-decisions/download") {
        return jsonResponse(
          202,
          modelFixture({
            profile: "typed-decisions",
            state: "downloading",
            progress: {
              done_bytes: 100,
              total_bytes: 842609220,
              current_file: "model.safetensors",
            },
          }),
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSetup();

    // The explicit download.
    screen.getByTestId("download-typed-decisions").click();
    await vi.waitFor(
      () => {
        expect(screen.getByTestId("state-typed-decisions").textContent).toBe(
          "Downloading",
        );
      },
      { timeout: 10000 },
    );
    expect(callsTo(fetchMock, "POST", "/v1/models/typed-decisions/download")).toBe(1);

    // The first poll has started and is still in flight.
    await vi.waitFor(() => expect(pollCount).toBe(1), { timeout: 10000 });

    // Several intervals elapse while the slow poll is in flight.
    // Serialization: no second /v1/models request may be issued, so an
    // out-of-order failure cannot strand the screen.
    await vi.advanceTimersByTimeAsync(3000);
    expect(pollCount).toBe(1);

    // The slow poll fails: temporary unreachability is shown.
    rejectFirstPoll(new Error("service blip"));
    await vi.waitFor(
      () => {
        expect(screen.getByTestId("service-reachability").textContent).toContain(
          "Temporarily unreachable",
        );
      },
      { timeout: 10000 },
    );

    // The next tick issues a fresh poll that succeeds with the terminal
    // state: reachability is restored and no second download starts.
    await vi.waitFor(
      () => {
        expect(screen.getByTestId("state-typed-decisions").textContent).toBe(
          "Installed",
        );
      },
      { timeout: 10000 },
    );
    expect(screen.getByTestId("service-reachability").textContent).toContain("Reachable");
    expect(pollCount).toBeGreaterThanOrEqual(2);
    expect(callsTo(fetchMock, "POST", "/v1/models/typed-decisions/download")).toBe(1);
  });

  it("invalidates a pending poll when a new download reruns the effect: the stale snapshot does not clobber state, observation continues to the terminal state, one download POST per profile", async () => {
    let pollCount = 0;
    // The first poll stays pending while the second download reruns the
    // polling effect, then completes with an obsolete snapshot.
    let resolveStalePoll: (response: Response) => void = () => undefined;
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/status") {
        return jsonResponse(200, statusFixture());
      }
      if (method === "GET" && url === "/v1/models") {
        pollCount += 1;
        if (pollCount === 1) {
          return new Promise<unknown>((resolve) => {
            resolveStalePoll = resolve;
          }) as unknown as Response;
        }
        if (pollCount === 2) {
          // The rerun effect's first poll: both still downloading.
          return jsonResponse(
            200,
            [
              modelFixture({
                profile: "typed-decisions",
                state: "downloading",
                progress: { done_bytes: 500, total_bytes: 842609220, current_file: null },
              }),
              modelFixture({
                profile: "english",
                state: "downloading",
                progress: { done_bytes: 500, total_bytes: 842609220, current_file: null },
              }),
            ],
          );
        }
        // Terminal: both installed and verified.
        return jsonResponse(
          200,
          [
            modelFixture({
              profile: "typed-decisions",
              state: "installed",
              disk_bytes: 842609220,
              verified_at: "2026-01-01T00:00:00+00:00",
            }),
            modelFixture({
              profile: "english",
              state: "installed",
              disk_bytes: 842609220,
              verified_at: "2026-01-01T00:00:00+00:00",
            }),
          ],
        );
      }
      if (method === "POST" && url === "/v1/models/typed-decisions/download") {
        return jsonResponse(
          202,
          modelFixture({
            profile: "typed-decisions",
            state: "downloading",
            progress: { done_bytes: 100, total_bytes: 842609220, current_file: null },
          }),
        );
      }
      if (method === "POST" && url === "/v1/models/english/download") {
        return jsonResponse(
          202,
          modelFixture({
            profile: "english",
            state: "downloading",
            progress: { done_bytes: 100, total_bytes: 842609220, current_file: null },
          }),
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSetup();

    // The first explicit download.
    screen.getByTestId("download-typed-decisions").click();
    await vi.waitFor(
      () => {
        expect(screen.getByTestId("state-typed-decisions").textContent).toBe("Downloading");
      },
      { timeout: 10000 },
    );

    // The first poll starts and stays pending.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(pollCount).toBe(1), { timeout: 10000 });

    // A second explicit download while the first poll is in flight:
    // ``watching`` changes, so the polling effect is cleaned up and
    // rerun while the first poll is still pending.
    screen.getByTestId("download-english").click();
    await vi.waitFor(
      () => {
        expect(screen.getByTestId("state-english").textContent).toBe("Downloading");
      },
      { timeout: 10000 },
    );

    // The stale poll completes with an obsolete terminal snapshot (both
    // installed, with a verification time that no current poll ever
    // reports): if it were applied, it would clobber the current
    // ``downloading`` state, remove both profiles from ``watching``, and
    // stop polling.
    await act(async () => {
      resolveStalePoll(
        jsonResponse(
          200,
          [
            modelFixture({
              profile: "typed-decisions",
              state: "installed",
              disk_bytes: 842609220,
              verified_at: "2025-12-31T00:00:00+00:00",
            }),
            modelFixture({
              profile: "english",
              state: "installed",
              disk_bytes: 842609220,
              verified_at: "2025-12-31T00:00:00+00:00",
            }),
          ],
        ),
      );
    });
    // The obsolete snapshot was not applied: both profiles still show the
    // current downloading state.
    expect(screen.getByTestId("state-typed-decisions").textContent).toBe("Downloading");
    expect(screen.getByTestId("state-english").textContent).toBe("Downloading");
    expect(screen.getByTestId("service-reachability").textContent).toContain("Reachable");

    // Observation continues through the rerun effect to the terminal
    // state.
    await vi.advanceTimersByTimeAsync(1000); // poll 2: both downloading
    await vi.advanceTimersByTimeAsync(1000); // poll 3: both installed
    await vi.waitFor(
      () => {
        expect(screen.getByTestId("state-typed-decisions").textContent).toBe("Installed");
      },
      { timeout: 10000 },
    );
    expect(screen.getByTestId("state-english").textContent).toBe("Installed");
    // Offline readiness follows the default model's terminal state.
    expect(screen.getByTestId("offline-ready").textContent).toContain("Yes");
    // The terminal state came from the current polls, not the obsolete
    // snapshot: the verification time is the one only polls 2+ report.
    expect(screen.getByTestId("verified-typed-decisions").textContent).toBe(
      "2026-01-01T00:00:00+00:00",
    );

    // Observation continued past the stale snapshot (polls 2 and 3 ran)...
    expect(pollCount).toBeGreaterThanOrEqual(3);
    // ...exactly one download POST per profile...
    expect(callsTo(fetchMock, "POST", "/v1/models/typed-decisions/download")).toBe(1);
    expect(callsTo(fetchMock, "POST", "/v1/models/english/download")).toBe(1);
    // ...and observation stopped after the terminal state.
    const polls = pollCount;
    await vi.advanceTimersByTimeAsync(3000);
    expect(pollCount).toBe(polls);
  });

  it("keeps observing after an accepted download whose immediate response is not_installed (startup race)", async () => {
    let pollCount = 0;
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/status") {
        return jsonResponse(200, statusFixture());
      }
      if (method === "GET" && url === "/v1/models") {
        pollCount += 1;
        if (pollCount === 1) {
          // Race window: the background thread has not reported yet.
          return jsonResponse(200, [modelFixture({ profile: "typed-decisions" })]);
        }
        if (pollCount === 2) {
          return jsonResponse(
            200,
            [
              modelFixture({
                profile: "typed-decisions",
                state: "downloading",
                progress: { done_bytes: 100, total_bytes: 842609220, current_file: null },
              }),
            ],
          );
        }
        return jsonResponse(
          200,
          [
            modelFixture({
              profile: "typed-decisions",
              state: "installed",
              disk_bytes: 842609220,
              verified_at: "2026-01-01T00:00:00+00:00",
            }),
          ],
        );
      }
      if (method === "POST" && url === "/v1/models/typed-decisions/download") {
        // Accepted (202), but the immediate status read still says
        // ``not_installed`` because the backend thread has not started.
        return jsonResponse(202, modelFixture({ profile: "typed-decisions" }));
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSetup();

    screen.getByTestId("download-typed-decisions").click();
    // Observation must continue past the race window (poll 1: still
    // not_installed, no error) and through the in-flight state (poll 2).
    await vi.waitFor(() => expect(pollCount).toBeGreaterThanOrEqual(2), {
      timeout: 10000,
    });
    await vi.waitFor(
      () => {
        expect(screen.getByTestId("state-typed-decisions").textContent).toBe("Installed");
      },
      { timeout: 10000 },
    );
    // Exactly one download was started; observation continued on its own.
    expect(callsTo(fetchMock, "POST", "/v1/models/typed-decisions/download")).toBe(1);
    expect(pollCount).toBeGreaterThanOrEqual(3);
  });

  it("stops observing a started download once it fails, with the error shown", async () => {
    let pollCount = 0;
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/status") {
        return jsonResponse(200, statusFixture());
      }
      if (method === "GET" && url === "/v1/models") {
        pollCount += 1;
        return jsonResponse(
          200,
          [
            modelFixture({
              profile: "typed-decisions",
              state: "not_installed",
              disk_bytes: 10,
              last_error: "could not download model.safetensors: TimeoutError",
            }),
          ],
        );
      }
      if (method === "POST" && url === "/v1/models/typed-decisions/download") {
        return jsonResponse(202, modelFixture({ profile: "typed-decisions" }));
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSetup();

    screen.getByTestId("download-typed-decisions").click();
    // The failure (not_installed + recorded error) is terminal: the error
    // is shown and observation stops.
    await vi.waitFor(
      () => {
        expect(screen.getByTestId("error-typed-decisions").textContent).toContain(
          "could not download model.safetensors",
        );
      },
      { timeout: 10000 },
    );
    await vi.advanceTimersByTimeAsync(1000); // let the effect cleanup settle
    const polls = pollCount;
    await vi.advanceTimersByTimeAsync(3000);
    expect(pollCount).toBe(polls);
    expect(callsTo(fetchMock, "POST", "/v1/models/typed-decisions/download")).toBe(1);
  });

  it("resumes observation, not a second download, when the page reloads during a download", async () => {
    let pollCount = 0;
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/status") {
        return jsonResponse(
          200,
          statusFixture({
            models: [
              modelFixture({
                profile: "typed-decisions",
                state: "downloading",
                progress: {
                  done_bytes: 5000,
                  total_bytes: 842609220,
                  current_file: "model.safetensors",
                },
              }),
              modelFixture({ profile: "english" }),
              modelFixture({ profile: "multilingual" }),
            ],
          }),
        );
      }
      if (method === "GET" && url === "/v1/models") {
        pollCount += 1;
        const done = pollCount >= 2;
        return jsonResponse(
          200,
          done
            ? [
                modelFixture({
                  profile: "typed-decisions",
                  state: "installed",
                  disk_bytes: 842609220,
                  verified_at: "2026-01-01T00:00:00+00:00",
                }),
              ]
            : [
                modelFixture({
                  profile: "typed-decisions",
                  state: "downloading",
                  progress: {
                    done_bytes: 9000,
                    total_bytes: 842609220,
                    current_file: "model.safetensors",
                  },
                }),
              ],
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSetup();

    // The in-flight download from before the reload is shown as-is...
    expect(screen.getByTestId("state-typed-decisions").textContent).toBe("Downloading");
    // ...observed through polling, with no new download started.
    await vi.waitFor(
      () => {
        expect(screen.getByTestId("state-typed-decisions").textContent).toBe("Installed");
      },
      { timeout: 10000 },
    );
    expect(callsTo(fetchMock, "POST", "/v1/models/typed-decisions/download")).toBe(0);
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });

  it("shows the installed, offline-ready state with a verify action", async () => {
    let models: ModelStatus[] = [
      modelFixture({
        profile: "typed-decisions",
        state: "installed",
        disk_bytes: 842609220,
        verified_at: "2026-01-01T00:00:00+00:00",
      }),
      modelFixture({
        profile: "english",
        state: "installed",
        disk_bytes: 842609210,
        verified_at: "2026-01-01T00:00:00+00:00",
      }),
      modelFixture({
        profile: "multilingual",
        state: "installed",
        disk_bytes: 678198702,
        verified_at: "2026-01-01T00:00:00+00:00",
      }),
    ];
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/status") {
        return jsonResponse(200, statusFixture({ offline_ready: true, models }));
      }
      if (method === "POST" && url === "/v1/models/typed-decisions/verify") {
        models = models.map((m) =>
          m.profile === "typed-decisions"
            ? { ...m, verified_at: "2026-02-02T00:00:00+00:00" }
            : m,
        );
        return jsonResponse(200, models[0]);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSetup();

    expect(screen.getByTestId("offline-ready").textContent).toContain("Yes");
    expect(screen.getByTestId("state-typed-decisions").textContent).toBe("Installed");
    expect(screen.getByTestId("state-auto").textContent).toBe(
      "Ready (routes between english and multilingual)",
    );
    expect(screen.getByTestId("verified-typed-decisions").textContent).toBe(
      "2026-01-01T00:00:00+00:00",
    );

    screen.getByTestId("verify-typed-decisions").click();
    await vi.waitFor(() => {
      expect(screen.getByTestId("verified-typed-decisions").textContent).toBe(
        "2026-02-02T00:00:00+00:00",
      );
    });
    expect(callsTo(fetchMock, "POST", "/v1/models/typed-decisions/verify")).toBe(1);
  });

  it("shows the damaged state with a download-again action, never as installed", async () => {
    let downloaded = false;
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/status") {
        return jsonResponse(
          200,
          statusFixture({
            models: [
              modelFixture({
                profile: "typed-decisions",
                state: "damaged",
                disk_bytes: 842609220,
                last_error:
                  "model.safetensors failed verification and was discarded; try again",
              }),
              modelFixture({ profile: "english" }),
              modelFixture({ profile: "multilingual" }),
            ],
          }),
        );
      }
      if (method === "POST" && url === "/v1/models/typed-decisions/download") {
        downloaded = true;
        return jsonResponse(
          202,
          modelFixture({
            profile: "typed-decisions",
            state: "downloading",
            progress: { done_bytes: 0, total_bytes: 842609220, current_file: null },
          }),
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSetup();

    const state = screen.getByTestId("state-typed-decisions").textContent ?? "";
    expect(state).toContain("Damaged");
    expect(state).not.toContain("Installed");
    expect(screen.getByTestId("error-typed-decisions").textContent).toContain(
      "failed verification",
    );
    expect(screen.getByTestId("phase-typed-decisions").textContent).toContain(
      "verification failed; not usable",
    );

    screen.getByTestId("redownload-typed-decisions").click();
    await vi.waitFor(() => expect(downloaded).toBe(true));
    expect(callsTo(fetchMock, "POST", "/v1/models/typed-decisions/download")).toBe(1);
  });

  it("recovers from an interrupted download after a service restart, never implying it is installed", async () => {
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/status") {
        return jsonResponse(
          200,
          statusFixture({
            models: [
              modelFixture({
                profile: "typed-decisions",
                state: "not_installed",
                disk_bytes: 123456789,
              }),
              modelFixture({ profile: "english" }),
              modelFixture({ profile: "multilingual" }),
            ],
          }),
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSetup();

    expect(screen.getByTestId("state-typed-decisions").textContent).toBe(
      "Interrupted download",
    );
    const card = screen.getByTestId("profile-typed-decisions").textContent ?? "";
    expect(card).not.toContain("Installed");
    expect(screen.getByTestId("status-live").textContent).toContain(
      "a new download resumes from there",
    );
    // The recovery path is an explicit action, and it resumes the partial file.
    expect(screen.getByTestId("download-typed-decisions").textContent).toBe(
      "Resume download",
    );
    expect(callsTo(fetchMock, "POST", "/v1/models/typed-decisions/download")).toBe(0);
  });

  it("shows a failed download with its error and a retry action", async () => {
    let downloaded = false;
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/status") {
        return jsonResponse(
          200,
          statusFixture({
            models: [
              modelFixture({
                profile: "typed-decisions",
                state: "not_installed",
                disk_bytes: 42,
                last_error: "could not download model.safetensors: TimeoutError",
              }),
              modelFixture({ profile: "english" }),
              modelFixture({ profile: "multilingual" }),
            ],
          }),
        );
      }
      if (method === "POST" && url === "/v1/models/typed-decisions/download") {
        downloaded = true;
        return jsonResponse(
          202,
          modelFixture({
            profile: "typed-decisions",
            state: "downloading",
            progress: { done_bytes: 42, total_bytes: 842609220, current_file: null },
          }),
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSetup();

    const state = screen.getByTestId("state-typed-decisions").textContent ?? "";
    expect(state).not.toContain("Installed");
    expect(screen.getByTestId("error-typed-decisions").textContent).toContain(
      "could not download model.safetensors",
    );
    expect(screen.getByTestId("download-typed-decisions").textContent).toBe(
      "Resume download",
    );
    screen.getByTestId("download-typed-decisions").click();
    await vi.waitFor(() => expect(downloaded).toBe(true));
    expect(callsTo(fetchMock, "POST", "/v1/models/typed-decisions/download")).toBe(1);
  });

  it("shows API errors with a retry action, and does not retry implicitly", async () => {
    let attempts = 0;
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/status") {
        attempts += 1;
        if (attempts === 1) {
          return jsonResponse(500, {
            code: "internal",
            message: "internal error",
            request_id: "rid-1",
          });
        }
        return jsonResponse(200, statusFixture());
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    render(<SetupScreen />);
    await vi.waitFor(() => expect(screen.queryByTestId("setup-error")).toBeTruthy());
    expect(screen.getByTestId("setup-error").textContent).toContain("internal error");

    screen.getByTestId("setup-retry").click();
    await vi.waitFor(() => expect(screen.queryByTestId("setup")).toBeTruthy());
    expect(attempts).toBe(2);
    expect(callsTo(fetchMock, "GET", "/v1/status")).toBe(2);
  });

  it("shows a failed verify as an error, without an implicit retry", async () => {
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/status") {
        return jsonResponse(
          200,
          statusFixture({
            models: [
              modelFixture({
                profile: "typed-decisions",
                state: "installed",
                disk_bytes: 842609220,
                verified_at: "2026-01-01T00:00:00+00:00",
              }),
              modelFixture({ profile: "english" }),
              modelFixture({ profile: "multilingual" }),
            ],
          }),
        );
      }
      if (method === "POST" && url === "/v1/models/typed-decisions/verify") {
        return jsonResponse(409, {
          code: "model_not_ready",
          message: "model 'typed-decisions' failed verification; download it again",
          request_id: "rid-2",
        });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSetup();

    screen.getByTestId("verify-typed-decisions").click();
    await vi.waitFor(() => expect(screen.queryByTestId("action-error")).toBeTruthy());
    expect(screen.getByTestId("action-error").textContent).toContain("failed verification");
    expect(callsTo(fetchMock, "POST", "/v1/models/typed-decisions/verify")).toBe(1);
  });

  it("previews diagnostics before copy or download, and the preview excludes sensitive fields", async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve(undefined));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const createObjectURL = vi.fn((_blob: Blob) => "blob:openreflex-test");
    const revokeObjectURL = vi.fn((_url: string) => undefined);
    vi.stubGlobal(
      "URL",
      Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }),
    );
    const appendSpy = vi.spyOn(document.body, "appendChild");
    // jsdom cannot follow the blob URL; the anchor is captured via appendChild.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/status") {
        return jsonResponse(
          200,
          statusFixture({
            offline_ready: true,
            models: [
              modelFixture({
                profile: "typed-decisions",
                state: "installed",
                disk_bytes: 842609220,
                verified_at: "2026-01-01T00:00:00+00:00",
              }),
              modelFixture({ profile: "english" }),
              modelFixture({ profile: "multilingual" }),
            ],
          }),
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSetup();

    // Preview first.
    screen.getByTestId("diagnostics-toggle").click();
    await vi.waitFor(() => expect(screen.queryByTestId("diagnostics-preview")).toBeTruthy());
    const preview = screen.getByTestId("diagnostics-preview").textContent ?? "";
    expect(preview).toContain("OpenReflex diagnostics");
    expect(preview).toContain("version: 0.1.0");
    expect(preview).toContain("typed-decisions: installed");
    expect(preview).toContain(`revision: ${REVISION}`);
    expect(preview).toContain("offline ready: yes");
    // Excluded: token, home-directory details.
    expect(preview).not.toContain(TOKEN);
    expect(preview).not.toContain("someone");
    expect(preview).not.toContain("AppData");

    // Copy, with the same text as the preview.
    screen.getByTestId("diagnostics-copy").click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toBe(preview);

    // Download, with the same text as the preview.
    screen.getByTestId("diagnostics-download").click();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    const contentPromise = new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob as Blob);
    });
    // jsdom drives the FileReader with internal timers; let them run.
    await vi.advanceTimersByTimeAsync(1000);
    expect(await contentPromise).toBe(preview);
    const anchor = appendSpy.mock.calls.at(-1)?.[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("openreflex-diagnostics.txt");
    expect(revokeObjectURL).toHaveBeenCalled();
  });
});
