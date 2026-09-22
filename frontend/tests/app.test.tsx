import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, SCREENS } from "../src/app";
import { bootstrapToken, clearToken } from "../src/token";

const NAMES = SCREENS.map((s) => s.name);
const IDS = SCREENS.map((s) => s.id);

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

beforeEach(() => {
  window.location.hash = "";
  clearToken();
  vi.unstubAllGlobals();
});

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

describe("app shell", () => {
  it("offers all five screens by keyboard, each with a unique heading and active state", async () => {
    render(<App />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(NAMES);

    // Native anchors are keyboard reachable: every one can take focus.
    for (const link of links) {
      link.focus();
      expect(document.activeElement).toBe(link);
    }
    // Correct hrefs, so activating a focused link (Enter) navigates.
    expect(links.map((l) => l.getAttribute("href"))).toEqual(IDS.map((id) => `#/${id}`));

    // Default: the first screen is the active one.
    expect(links[0].getAttribute("aria-current")).toBe("page");

    for (let i = 0; i < IDS.length; i += 1) {
      window.location.hash = `#/${IDS[i]}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await vi.waitFor(() => {
        expect(screen.getByRole("heading", { level: 1, name: NAMES[i] })).toBeTruthy();
      });
      const current = screen.getAllByRole("link");
      expect(current[i].getAttribute("aria-current")).toBe("page");
      for (let j = 0; j < current.length; j += 1) {
        if (j !== i) {
          expect(current[j].getAttribute("aria-current")).toBeNull();
        }
      }
    }
  });

  it("shows a recovery state without credentials when the token is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await vi.waitFor(() => expect(screen.getByTestId("recovery")).toBeTruthy());
    expect(screen.getByText(/Relaunch through OpenReflex/i)).toBeTruthy();
    expect(screen.getByText(/no sign-in/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain("tok-missing-xyz");
    // A missing token must not trigger a network call.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a recovery state when the token is rejected, without exposing it", async () => {
    window.location.hash = "#token=tok-rejected-999";
    bootstrapToken();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(401, {
          code: "unauthorized",
          message: "missing or invalid token",
          request_id: "rid-9",
        }),
      ),
    );
    render(<App />);
    await vi.waitFor(() => expect(screen.getByTestId("recovery")).toBeTruthy());
    expect(screen.getByText(/rejected by the local service/i)).toBeTruthy();
    expect(screen.getByText(/Relaunch through OpenReflex/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain("tok-rejected-999");
  });

  it("renders service errors as plain text and never renders the token", async () => {
    window.location.hash = "#token=tok-error-888";
    bootstrapToken();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(500, {
          code: "internal",
          message: "internal error <script>window.pwned = true</script>",
          request_id: "rid-8",
        }),
      ),
    );
    render(<App />);
    await vi.waitFor(() => expect(screen.getByTestId("service-error")).toBeTruthy());
    expect(screen.getByText(/internal error/i)).toBeTruthy();
    // React escapes the message: it is text, not markup.
    expect(document.body.innerHTML).not.toContain("<script>window.pwned");
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      expect(script.textContent).not.toContain("pwned");
    }
    expect(document.body.textContent).not.toContain("tok-error-888");
  });

  it("shows the Setup screen once the service is reachable, and placeholders for later screens", async () => {
    window.location.hash = "#token=tok-ready-777";
    bootstrapToken();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          200,
          {
            product: "OpenReflex",
            version: "0.1.0",
            contract_version: 1,
            attribution:
              "Powered by Laya, an open-source System 1 decision model developed by Convai Innovations.",
            offline_ready: false,
            default_profile: "typed-decisions",
            engine: { engine: "fake", loaded_profile: null, loaded_checkpoint: null },
            models: [],
            queue_depth: 0,
            queue_capacity: 16,
            history: {
              enabled: false,
              what_is_stored: "decision inputs, outputs, and timestamps",
            },
            data_dir: "C:\\Users\\someone\\AppData\\Local\\OpenReflex",
          },
          { "x-request-id": "rid-7" },
        ),
      ),
    );
    render(<App />);
    await vi.waitFor(() => expect(screen.getByTestId("setup")).toBeTruthy());
    expect(screen.getByText(/Offline ready/i)).toBeTruthy();

    // The Recipes screen is built (task 4). The mock answers every request
    // with the status payload, so the recipe list load fails gracefully;
    // the screen body itself must be the Recipes screen, not a placeholder.
    window.location.hash = "#/recipes";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await vi.waitFor(() => expect(screen.getByTestId("recipes")).toBeTruthy());
    expect(screen.queryByTestId("placeholder")).toBeNull();
  });

  // Render the app with a reachable service (so the Recipes screen loads its
  // list) and sign-in, ready for unsaved-edit protection tests.
  async function renderReadyApp(): Promise<void> {
    window.location.hash = "#token=tok-guard-111";
    bootstrapToken();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        if (input === "/v1/status") {
          return Promise.resolve(
            jsonResponse(
              200,
              {
                product: "OpenReflex",
                version: "0.1.0",
                contract_version: 1,
                attribution:
                  "Powered by Laya, an open-source System 1 decision model developed by Convai Innovations.",
                offline_ready: false,
                default_profile: "typed-decisions",
                engine: { engine: "fake", loaded_profile: null, loaded_checkpoint: null },
                models: [],
                queue_depth: 0,
                queue_capacity: 16,
                history: {
                  enabled: false,
                  what_is_stored: "decision inputs, outputs, and timestamps",
                },
                data_dir: "C:\\Users\\someone\\AppData\\Local\\OpenReflex",
              },
              { "x-request-id": "rid-guard" },
            ),
          );
        }
        if (input === "/v1/recipes") {
          return Promise.resolve(jsonResponse(200, { recipes: [], invalid: [] }));
        }
        return Promise.resolve(jsonResponse(200, {}));
      }),
    );
    render(<App />);
    await vi.waitFor(() => expect(screen.getByTestId("setup")).toBeTruthy());
  }

  // Open a new recipe and dirty it, so the leave guard becomes active.
  async function makeRecipesDirty(): Promise<void> {
    window.location.hash = "#/recipes";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await vi.waitFor(() => expect(screen.getByTestId("recipes")).toBeTruthy());
    screen.getByTestId("new-recipe").click();
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-form")).toBeTruthy());
    fireEvent.change(screen.getByTestId("field-id"), { target: { value: "unsaved" } });
    // Flush the guard setup (RecipesScreen effect -> App guardActive -> the
    // beforeunload listener) before the test asserts on it.
    await act(async () => {});
  }

  it("keeps the form and prompts when the browser navigates away via hash", async () => {
    await renderReadyApp();
    await makeRecipesDirty();
    // Simulate browser Back/Forward: the hash changes to another screen.
    window.location.hash = "#/setup";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    // The guard intercepts: the hash is restored and the confirmation is shown.
    await vi.waitFor(() => expect(screen.queryByTestId("discard-dialog")).toBeTruthy());
    expect(window.location.hash).toBe("#/recipes");
    // The form is preserved.
    expect(screen.queryByTestId("recipe-form")).toBeTruthy();
    // Staying keeps the form and the screen.
    screen.getByTestId("discard-stay").click();
    await vi.waitFor(() => expect(screen.queryByTestId("discard-dialog")).toBeNull());
    expect(screen.queryByTestId("recipe-form")).toBeTruthy();
    expect(window.location.hash).toBe("#/recipes");
  });

  it("prompts on beforeunload (refresh/close) while the form is dirty", async () => {
    await renderReadyApp();
    await makeRecipesDirty();
    // The handler calls ``preventDefault()`` (and sets ``returnValue``); in a
    // real browser that triggers the native "leave site?" prompt. jsdom's
    // ``Event.returnValue`` setter is a no-op, so ``preventDefault`` is the
    // observable signal that unload protection is active.
    const event = new Event("beforeunload");
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);
    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
  });

  it("does not prompt on beforeunload while the form is not dirty", async () => {
    await renderReadyApp();
    // No form is open (not dirty): no unload protection is registered.
    const event = new Event("beforeunload");
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);
    expect(preventDefaultSpy).not.toHaveBeenCalled();
  });
});
