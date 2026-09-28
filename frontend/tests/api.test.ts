import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, CanceledError, request } from "../src/api";
import { bootstrapToken, clearToken } from "../src/token";

const TOKEN = "tok-api-1234567890";

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
  window.location.hash = `#token=${TOKEN}`;
  bootstrapToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("same-origin API client", () => {
  it("sends the token only in the Authorization header, never in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { product: "OpenReflex" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await request<{ product: string }>("GET", "/v1/status");
    expect(result).toEqual({ product: "OpenReflex" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/status");
    expect(String(url)).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("sends the JSON body for mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { id: "triage" }));
    vi.stubGlobal("fetch", fetchMock);
    await request("POST", "/v1/recipes", { id: "triage" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ id: "triage" }));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("surfaces the product error envelope and the request id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        404,
        {
          code: "recipe_not_found",
          message: "no recipe with that id",
          request_id: "rid-1",
          issues: [{ location: "id", message: "unknown id" }],
        },
        { "x-request-id": "rid-1" },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const error = await request("GET", "/v1/recipes/nope").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(404);
    expect(apiError.code).toBe("recipe_not_found");
    expect(apiError.message).toBe("no recipe with that id");
    expect(apiError.requestId).toBe("rid-1");
    expect(apiError.issues).toEqual([{ location: "id", message: "unknown id" }]);
    expect(apiError.message).not.toContain(TOKEN);
  });

  it("falls back to the request id header when the envelope has none", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(409, { code: "recipe_exists", message: "already exists" }, {
        "x-request-id": "rid-header",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const error = await request("POST", "/v1/recipes").catch((e: unknown) => e) as ApiError;
    expect(error.requestId).toBe("rid-header");
  });

  it("supports cancellation through an abort signal", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve: unknown, reject: (e: unknown) => void) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pending = request("GET", "/v1/status", undefined, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(CanceledError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(
      request("GET", "/v1/status", undefined, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(CanceledError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never retries a failed mutation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(409, { code: "recipe_exists", message: "a recipe with this id already exists" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(request("PUT", "/v1/recipes/triage", { id: "triage" })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails locally without a network call when the tab has no token", async () => {
    clearToken();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(request("GET", "/v1/status")).rejects.toMatchObject({ code: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns network failures into a safe error that never contains the token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const error = await request("GET", "/v1/status").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("network");
    expect((error as ApiError).message).not.toContain(TOKEN);
  });
});

describe("path validation (same-origin only)", () => {
  const rejectedPaths = [
    ["an absolute https URL", "https://evil.example/v1/status"],
    ["an absolute http URL", "http://evil.example/"],
    ["an absolute https URL with no path", "https://evil.example"],
    ["a protocol-relative URL", "//evil.example/v1/status"],
    ["a protocol-relative URL with three slashes", "///evil.example"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a data: URL", "data:text/plain,hi"],
    ["a file: URL", "file:///etc/passwd"],
    ["a backslash path", "/v1\\status"],
    ["a backslash path without a leading slash", "\\v1\\status"],
    ["an encoded slash separator", "/v1/status%2F.."],
    ["an encoded slash separator (uppercase)", "/v1/status%2F"],
    ["an encoded backslash separator", "/v1%5cstatus"],
    ["an encoded backslash separator (uppercase)", "/v1%5Cstatus"],
    ["a dot-dot segment", "/v1/../admin"],
    ["a dot segment", "/v1/./status"],
    ["an encoded dot-dot segment", "/v1/%2e%2e/admin"],
    ["an encoded dot-dot segment (uppercase hex)", "/v1/%2E%2E/admin"],
    ["an encoded dot-dot segment (mixed-case hex)", "/v1/%2e%2E/admin"],
    ["a mixed literal and encoded dot-dot segment", "/v1/.%2e/admin"],
    ["a mixed encoded and literal dot-dot segment", "/v1/%2E./admin"],
    ["a mixed literal and encoded dot-dot segment (uppercase hex)", "/v1/.%2E/admin"],
    ["an encoded dot segment", "/v1/%2e/status"],
    ["an encoded dot segment (uppercase hex)", "/v1/%2E/status"],
    ["a trailing encoded dot-dot segment", "/v1/%2e%2e"],
    ["a query string", "/v1/status?x=1"],
    ["a fragment", "/v1/status#frag"],
    ["an embedded newline", "/v1/status\n"],
    ["a leading space", " /v1/status"],
    ["a malformed percent escape", "/v1/status%zz"],
    ["a non-API absolute path", "/admin"],
    ["a path that only looks like /v1", "/v1x"],
    ["a differently-cased /v1", "/V1/status"],
  ] as const;

  for (const [label, path] of rejectedPaths) {
    it(`rejects ${label} without calling fetch and without exposing the token`, async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const error = await request("GET", path).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("invalid_path");
      expect(fetchMock).not.toHaveBeenCalled();
      expect((error as ApiError).message).not.toContain(TOKEN);
      expect((error as ApiError).message).not.toContain(path);
    });
  }

  it("rejects an absolute URL even when it names a local-looking /v1 path", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const error = await request("GET", "https://127.0.0.1/v1/status").catch((e: unknown) => e);
    expect((error as ApiError).code).toBe("invalid_path");
    expect(fetchMock).not.toHaveBeenCalled();
    expect((error as ApiError).message).not.toContain(TOKEN);
  });

  it("rejects an invalid path even when the tab has no token", async () => {
    clearToken();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const error = await request("GET", "//evil.example/v1/status").catch((e: unknown) => e);
    expect((error as ApiError).code).toBe("invalid_path");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still accepts the API root path /v1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    await request("GET", "/v1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still accepts ordinary /v1 paths, including valid percent-escapes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "my recipe" }));
    vi.stubGlobal("fetch", fetchMock);
    await request("GET", "/v1/recipes/my%20recipe");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/recipes/my%20recipe");
  });
});
