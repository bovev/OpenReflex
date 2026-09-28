import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsScreen } from "../src/settings";
import { bootstrapToken, clearToken } from "../src/token";
import type { ModelStatus, StatusReport } from "../src/types";

const TOKEN = "tok-settings-123";
const DATA_DIR = "C:\\Users\\someone\\AppData\\Local\\OpenReflex";
const REVISION = "1c5edc17a7acd8701df6fc341c0d179f1c62c982";
// The API's exact what_is_stored explanation (backend WHAT_IS_STORED).
const WHAT_IS_STORED =
  "time, recipe id, overall review status, model name and revision, each question's " +
  "answer with its confidence and review status, and warning codes. The text or JSON " +
  "you submit is never stored.";

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
    history: { enabled: false, what_is_stored: WHAT_IS_STORED },
    data_dir: DATA_DIR,
    ...overrides,
  };
}

function setupFetch(
  handler: (method: string, url: string, init?: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    return Promise.resolve(handler(method, input, init));
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

function basicHandler(
  status: StatusReport,
  preferences: { history_enabled: boolean },
): (method: string, url: string) => Response {
  return (method, url) => {
    if (method === "GET" && url === "/v1/status") {
      return jsonResponse(200, status);
    }
    if (method === "GET" && url === "/v1/preferences") {
      return jsonResponse(200, preferences);
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
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

async function renderSettings(): Promise<void> {
  render(<SettingsScreen />);
  await vi.waitFor(() => {
    expect(
      screen.queryByTestId("settings") !== null || screen.queryByTestId("settings-error") !== null,
    ).toBe(true);
  });
}

describe("settings screen", () => {
  it("shows the app and version, the read-only data directory, the attribution, and the bundled notices, with no request beyond status and preferences", async () => {
    const fetchMock = setupFetch(
      basicHandler(statusFixture(), { history_enabled: false }),
    );
    await renderSettings();

    // App/version information.
    expect(screen.getByTestId("product-version").textContent).toBe("OpenReflex 0.1.0");
    expect(screen.getByTestId("about").textContent).toContain("1");

    // The data directory as read-only information.
    expect(screen.getByTestId("data-dir").textContent).toBe(DATA_DIR);
    expect(screen.getByTestId("data-dir-note").textContent).toContain("Read-only");

    // The server-owned Laya attribution.
    expect(screen.getByTestId("attribution").textContent).toContain("Powered by Laya");
    expect(screen.getByTestId("attribution").textContent).toContain("Convai Innovations");

    // Bundled notices: available without any external request.
    expect(screen.getByTestId("notice-project").textContent).toContain("Apache-2.0");
    expect(screen.getByTestId("notice-project").textContent).toContain("no telemetry");
    expect(screen.getByTestId("notice-laya").textContent).toContain("Convai Innovations");
    expect(screen.getByTestId("notice-laya").textContent).toContain(
      "used only through openreflex.laya_adapter",
    );
    expect(screen.getByTestId("notice-dependencies").textContent).toContain("pending");

    // Only the two reads were issued.
    expect(callsTo(fetchMock, "GET", "/v1/status")).toBe(1);
    expect(callsTo(fetchMock, "GET", "/v1/preferences")).toBe(1);
  });

  it("shows history off by default with the API's exact what_is_stored explanation, and changes nothing on load", async () => {
    const fetchMock = setupFetch(
      basicHandler(statusFixture(), { history_enabled: false }),
    );
    await renderSettings();

    expect(screen.getByTestId("history-state").textContent).toBe("History: Off");
    const off = screen.getByTestId("history-off-default").textContent ?? "";
    expect(off).toContain("off by default");
    expect(off).toContain(WHAT_IS_STORED);
    // The exact API text, not a paraphrase.
    expect(off).toContain("The text or JSON you submit is never stored.");

    // No history mutation on load.
    expect(callsTo(fetchMock, "PUT", "/v1/preferences")).toBe(0);
    expect(callsTo(fetchMock, "DELETE", "/v1/history")).toBe(0);
  });

  it("enables history only after a distinct explicit typed confirmation, using /v1/preferences", async () => {
    let putBody: unknown = null;
    const fetchMock = setupFetch((method, url, init) => {
      if (method === "GET" && url === "/v1/status") {
        return jsonResponse(200, statusFixture());
      }
      if (method === "GET" && url === "/v1/preferences") {
        return jsonResponse(200, { history_enabled: false });
      }
      if (method === "PUT" && url === "/v1/preferences") {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { history_enabled: true });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSettings();

    // The explicit action opens the confirmation; the what_is_stored
    // explanation is shown before the confirm.
    screen.getByTestId("enable-history").click();
    await vi.waitFor(() => expect(screen.queryByTestId("confirm-dialog")).toBeTruthy());
    expect(screen.getByTestId("confirm-detail").textContent).toContain(WHAT_IS_STORED);

    // The confirmation is not accepted early.
    const input = screen.getByTestId("confirm-input");
    const submit = screen.getByTestId("confirm-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "enab" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "enable" } });
    expect(submit.disabled).toBe(false);
    submit.click();

    // One PUT with the exact preference, and the state flips on.
    expect(putBody).toEqual({ history_enabled: true });
    await vi.waitFor(() =>
      expect(screen.getByTestId("history-state").textContent).toBe("History: On"),
    );
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    expect(screen.queryByTestId("enable-history")).toBeNull();
    expect(screen.getByTestId("disable-history")).toBeTruthy();
    expect(screen.getByTestId("clear-history")).toBeTruthy();
    expect(callsTo(fetchMock, "PUT", "/v1/preferences")).toBe(1);
    expect(callsTo(fetchMock, "DELETE", "/v1/history")).toBe(0);
  });

  it("turns history off (opt-out) with an explicit action, using /v1/preferences", async () => {
    let putBody: unknown = null;
    const fetchMock = setupFetch((method, url, init) => {
      if (method === "GET" && url === "/v1/status") {
        return jsonResponse(
          200,
          statusFixture({ history: { enabled: true, what_is_stored: WHAT_IS_STORED } }),
        );
      }
      if (method === "GET" && url === "/v1/preferences") {
        return jsonResponse(200, { history_enabled: true });
      }
      if (method === "PUT" && url === "/v1/preferences") {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { history_enabled: false });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSettings();

    expect(screen.getByTestId("history-state").textContent).toBe("History: On");
    expect(screen.getByTestId("history-on-stored").textContent).toContain(WHAT_IS_STORED);

    // Turning it off is a direct explicit action.
    screen.getByTestId("disable-history").click();
    await vi.waitFor(() =>
      expect(screen.getByTestId("history-state").textContent).toBe("History: Off"),
    );
    expect(putBody).toEqual({ history_enabled: false });
    expect(screen.getByTestId("enable-history")).toBeTruthy();
    expect(screen.queryByTestId("clear-history")).toBeNull();
    expect(callsTo(fetchMock, "PUT", "/v1/preferences")).toBe(1);
  });

  it("clears history only after a distinct explicit typed confirmation, using /v1/history", async () => {
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/status") {
        return jsonResponse(
          200,
          statusFixture({ history: { enabled: true, what_is_stored: WHAT_IS_STORED } }),
        );
      }
      if (method === "GET" && url === "/v1/preferences") {
        return jsonResponse(200, { history_enabled: true });
      }
      if (method === "DELETE" && url === "/v1/history") {
        return jsonResponse(204, null);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSettings();

    screen.getByTestId("clear-history").click();
    await vi.waitFor(() => expect(screen.queryByTestId("confirm-dialog")).toBeTruthy());
    expect(screen.getByTestId("confirm-dialog").textContent).toContain("Clear history");
    expect(screen.getByTestId("confirm-detail").textContent).toContain("cannot be undone");

    // A different word than the enable confirmation is not accepted.
    const input = screen.getByTestId("confirm-input");
    const submit = screen.getByTestId("confirm-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "enable" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "clear" } });
    expect(submit.disabled).toBe(false);
    submit.click();

    await vi.waitFor(() => expect(callsTo(fetchMock, "DELETE", "/v1/history")).toBe(1));
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    // Clearing does not change the preference.
    expect(callsTo(fetchMock, "PUT", "/v1/preferences")).toBe(0);
  });

  it("lists models with profile, revision, disk use, and verification state, and explains that removal is separate from uninstall", async () => {
    setupFetch(
      basicHandler(
        statusFixture({
          models: [
            modelFixture({
              profile: "typed-decisions",
              state: "installed",
              disk_bytes: 842609220,
              verified_at: "2026-01-01T00:00:00+00:00",
            }),
            modelFixture({
              profile: "english",
              state: "damaged",
              disk_bytes: 842609210,
              last_error:
                "model.safetensors failed verification and was discarded; try again",
            }),
            modelFixture({ profile: "multilingual" }),
          ],
        }),
        { history_enabled: false },
      ),
    );
    await renderSettings();

    // Installed: revision, disk use, verification state, removal offered.
    expect(screen.getByTestId("model-state-typed-decisions").textContent).toBe("Installed");
    expect(screen.getByTestId("model-revision-typed-decisions").textContent).toBe(REVISION);
    expect(screen.getByTestId("model-disk-typed-decisions").textContent).toBe("803.6 MiB");
    expect(screen.getByTestId("model-verified-typed-decisions").textContent).toBe(
      "Verified 2026-01-01T00:00:00+00:00",
    );
    expect(screen.getByTestId("remove-typed-decisions")).toBeTruthy();

    // Damaged: verification state and error, removal offered.
    expect(screen.getByTestId("model-state-english").textContent).toContain("Damaged");
    expect(screen.getByTestId("model-verified-english").textContent).toBe(
      "Verification failed",
    );
    expect(screen.getByTestId("model-error-english").textContent).toContain(
      "failed verification",
    );
    expect(screen.getByTestId("remove-english")).toBeTruthy();

    // Not installed, no files: never verified, nothing to remove.
    expect(screen.getByTestId("model-state-multilingual").textContent).toBe("Not installed");
    expect(screen.getByTestId("model-verified-multilingual").textContent).toBe(
      "Never verified",
    );
    expect(screen.queryByTestId("remove-multilingual")).toBeNull();

    // Removal is separate from uninstall.
    expect(screen.getByTestId("removal-explanation").textContent).toContain(
      "does not uninstall",
    );
    expect(screen.getByTestId("removal-explanation").textContent).toContain(
      "does not touch your recipes",
    );
  });

  it("does not offer a removal while a model is downloading", async () => {
    setupFetch(
      basicHandler(
        statusFixture({
          models: [
            modelFixture({
              profile: "typed-decisions",
              state: "downloading",
              progress: { done_bytes: 100, total_bytes: 842609220, current_file: null },
            }),
            modelFixture({ profile: "english" }),
            modelFixture({ profile: "multilingual" }),
          ],
        }),
        { history_enabled: false },
      ),
    );
    await renderSettings();

    expect(screen.getByTestId("model-state-typed-decisions").textContent).toBe("Downloading");
    expect(screen.getByTestId("model-verified-typed-decisions").textContent).toBe(
      "In progress",
    );
    expect(screen.queryByTestId("remove-typed-decisions")).toBeNull();
    expect(screen.getByTestId("model-typed-decisions").textContent).toContain(
      "Download in progress",
    );
  });

  it("removes a model only after typing the exact profile, sending the confirm query", async () => {
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
      if (method === "GET" && url === "/v1/preferences") {
        return jsonResponse(200, { history_enabled: false });
      }
      if (method === "DELETE" && url === "/v1/models/typed-decisions?confirm=typed-decisions") {
        return jsonResponse(
          200,
          modelFixture({ profile: "typed-decisions", disk_bytes: 0 }),
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSettings();

    screen.getByTestId("remove-typed-decisions").click();
    await vi.waitFor(() => expect(screen.queryByTestId("confirm-dialog")).toBeTruthy());
    expect(screen.getByTestId("confirm-dialog").textContent).toContain(
      "Remove the typed-decisions model",
    );

    // A different profile name is not accepted.
    const input = screen.getByTestId("confirm-input");
    const submit = screen.getByTestId("confirm-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "english" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "typed-decisions" } });
    expect(submit.disabled).toBe(false);
    submit.click();

    await vi.waitFor(() =>
      expect(
        callsTo(fetchMock, "DELETE", "/v1/models/typed-decisions?confirm=typed-decisions"),
      ).toBe(1),
    );
  });

  it("shows the removed state after a successful removal, without touching recipes or the data directory", async () => {
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
      if (method === "GET" && url === "/v1/preferences") {
        return jsonResponse(200, { history_enabled: false });
      }
      if (method === "DELETE" && url === "/v1/models/typed-decisions?confirm=typed-decisions") {
        return jsonResponse(
          200,
          modelFixture({ profile: "typed-decisions", disk_bytes: 0 }),
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSettings();

    screen.getByTestId("remove-typed-decisions").click();
    await vi.waitFor(() => expect(screen.queryByTestId("confirm-dialog")).toBeTruthy());
    fireEvent.change(screen.getByTestId("confirm-input"), {
      target: { value: "typed-decisions" },
    });
    screen.getByTestId("confirm-submit").click();

    // The removed state replaces the installed one.
    await vi.waitFor(() =>
      expect(screen.getByTestId("model-state-typed-decisions").textContent).toBe(
        "Not installed",
      ),
    );
    expect(screen.getByTestId("model-disk-typed-decisions").textContent).toBe("0 B");
    expect(screen.queryByTestId("remove-typed-decisions")).toBeNull();

    // The removal touched nothing else: no recipe deletion, no other
    // mutation, and the data directory stays read-only information.
    expect(callsTo(fetchMock, "DELETE", "/v1/recipes/email-triage")).toBe(0);
    for (const [url] of fetchMock.mock.calls) {
      const allowed = [
        "/v1/status",
        "/v1/preferences",
        "/v1/models/typed-decisions?confirm=typed-decisions",
      ];
      expect(allowed).toContain(String(url));
    }
    expect(screen.getByTestId("data-dir").textContent).toBe(DATA_DIR);
  });

  it("keeps destructive controls disabled while a removal is pending, renders the structured API failure, and does not retry", async () => {
    let settleRemove: (response: Response) => void = () => undefined;
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/status") {
        return jsonResponse(
          200,
          statusFixture({
            history: { enabled: true, what_is_stored: WHAT_IS_STORED },
            models: [
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
              modelFixture({ profile: "multilingual" }),
            ],
          }),
        );
      }
      if (method === "GET" && url === "/v1/preferences") {
        return jsonResponse(200, { history_enabled: true });
      }
      if (method === "DELETE" && url === "/v1/models/typed-decisions?confirm=typed-decisions") {
        return new Promise<Response>((resolve) => {
          settleRemove = resolve;
        });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderSettings();

    screen.getByTestId("remove-typed-decisions").click();
    await vi.waitFor(() => expect(screen.queryByTestId("confirm-dialog")).toBeTruthy());
    fireEvent.change(screen.getByTestId("confirm-input"), {
      target: { value: "typed-decisions" },
    });
    screen.getByTestId("confirm-submit").click();

    // While the removal is pending, every destructive control is disabled.
    await vi.waitFor(() => {
      expect(
        (screen.getByTestId("remove-english") as HTMLButtonElement).disabled,
      ).toBe(true);
    });
    expect((screen.getByTestId("clear-history") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("disable-history") as HTMLButtonElement).disabled).toBe(true);

    // The structured API failure is rendered safely.
    await act(async () => {
      settleRemove(
        jsonResponse(409, {
          code: "model_busy",
          message: "this model is being downloaded or changed",
          request_id: "rid-9",
        }),
      );
    });
    await vi.waitFor(() => expect(screen.queryByTestId("action-error")).toBeTruthy());
    expect(screen.getByTestId("action-error").textContent).toContain(
      "this model is being downloaded or changed",
    );
    // No implicit retry of the failed mutation.
    expect(
      callsTo(fetchMock, "DELETE", "/v1/models/typed-decisions?confirm=typed-decisions"),
    ).toBe(1);
  });

  it("reuses the Setup diagnostics: the preview keeps the sensitive exclusions while the data directory is shown read-only in About", async () => {
    const fetchMock = setupFetch(
      basicHandler(
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
        { history_enabled: false },
      ),
    );
    await renderSettings();

    screen.getByTestId("diagnostics-toggle").click();
    await vi.waitFor(() => expect(screen.queryByTestId("diagnostics-preview")).toBeTruthy());
    const preview = screen.getByTestId("diagnostics-preview").textContent ?? "";
    expect(preview).toContain("OpenReflex diagnostics");
    expect(preview).toContain("version: 0.1.0");
    expect(preview).toContain(`revision: ${REVISION}`);
    // Excluded: token and home-directory details.
    expect(preview).not.toContain(TOKEN);
    expect(preview).not.toContain("AppData");
    expect(preview).not.toContain("someone");
    // While the diagnostics stay clean, About shows the real path
    // read-only.
    expect(screen.getByTestId("data-dir").textContent).toBe(DATA_DIR);
    expect(callsTo(fetchMock, "GET", "/v1/status")).toBe(1);
  });

  it("shows a load error with a retry action, and does not retry implicitly", async () => {
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
      if (method === "GET" && url === "/v1/preferences") {
        return jsonResponse(200, { history_enabled: false });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    render(<SettingsScreen />);
    await vi.waitFor(() => expect(screen.queryByTestId("settings-error")).toBeTruthy());
    expect(screen.getByTestId("settings-error").textContent).toContain("internal error");

    screen.getByTestId("settings-retry").click();
    await vi.waitFor(() => expect(screen.queryByTestId("settings")).toBeTruthy());
    expect(attempts).toBe(2);
    expect(callsTo(fetchMock, "GET", "/v1/status")).toBe(2);
  });
});
