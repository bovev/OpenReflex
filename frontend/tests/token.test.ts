import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TokenModule = typeof import("../src/token");

async function freshTokenModule(): Promise<TokenModule> {
  vi.resetModules();
  return import("../src/token");
}

beforeEach(() => {
  window.location.hash = "";
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("token bootstrap", () => {
  it("extracts the token from the launch fragment and removes it from the URL", async () => {
    window.location.hash = "#token=tok-abc-123";
    const token = await freshTokenModule();
    expect(token.bootstrapToken()).toBe("tok-abc-123");
    expect(window.location.href).not.toContain("tok-abc-123");
    expect(window.location.hash).toBe("");
  });

  it("keeps the token in tab-scoped memory and never lets a later fragment replace it", async () => {
    window.location.hash = "#token=tok-abc-123";
    const token = await freshTokenModule();
    expect(token.getToken()).toBeNull();
    token.bootstrapToken();
    expect(token.getToken()).toBe("tok-abc-123");
    // A later navigation (or page trickery) cannot swap the tab's token.
    window.location.hash = "#token=some-other-token";
    expect(token.bootstrapToken()).toBe("tok-abc-123");
    expect(token.getToken()).toBe("tok-abc-123");
  });

  it("never writes the token to localStorage, sessionStorage, or cookies", async () => {
    window.location.hash = "#token=tok-abc-123";
    const token = await freshTokenModule();
    token.bootstrapToken();
    expect(Object.keys(localStorage)).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
    expect(document.cookie).toBe("");
  });

  it("does not carry the token into a fresh tab", async () => {
    window.location.hash = "#token=first-tab";
    const first = await freshTokenModule();
    first.bootstrapToken();
    expect(first.getToken()).toBe("first-tab");

    // A new tab is a fresh page: no fragment, fresh module state.
    window.location.hash = "";
    const second = await freshTokenModule();
    expect(second.getToken()).toBeNull();
    expect(second.bootstrapToken()).toBeNull();
  });

  it("returns null when the fragment carries no token and leaves the URL alone", async () => {
    window.location.hash = "#/setup";
    const token = await freshTokenModule();
    expect(token.bootstrapToken()).toBeNull();
    expect(token.getToken()).toBeNull();
    expect(window.location.hash).toBe("#/setup");
  });

  it("returns null for an empty token value", async () => {
    window.location.hash = "#token=";
    const token = await freshTokenModule();
    expect(token.bootstrapToken()).toBeNull();
  });

  it("never logs the token", async () => {
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.join(" "));
      });
    }
    window.location.hash = "#token=tok-secret-456";
    const token = await freshTokenModule();
    token.bootstrapToken();
    expect(logged.join(" ")).not.toContain("tok-secret-456");
  });
});
