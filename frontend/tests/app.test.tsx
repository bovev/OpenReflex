import { cleanup, render, screen } from "@testing-library/react";
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

  it("shows placeholder bodies once the service is reachable", async () => {
    window.location.hash = "#token=tok-ready-777";
    bootstrapToken();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { product: "OpenReflex" })),
    );
    render(<App />);
    await vi.waitFor(() => expect(screen.getByTestId("placeholder")).toBeTruthy());
    expect(screen.getByText(/Setup is ready/i)).toBeTruthy();
  });
});
