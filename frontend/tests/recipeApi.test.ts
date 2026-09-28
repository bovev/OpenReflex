import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, requestText, requestWithQuery } from "../src/api";
import { bootstrapToken, clearToken } from "../src/token";

const TOKEN = "tok-recipe-api";

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
  clearToken();
});

describe("requestWithQuery (strict query parameters)", () => {
  it("sends the confirm guard in the query string, with the token only in the header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(204, ""));
    vi.stubGlobal("fetch", fetchMock);
    await requestWithQuery("DELETE", "/v1/recipes/my-recipe", [
      { key: "confirm", value: "my-recipe" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/recipes/my-recipe?confirm=my-recipe");
    expect(String(url)).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("returns undefined for a 204 and the envelope for a 200", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(204, ""))
      .mockResolvedValueOnce(jsonResponse(200, { id: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      requestWithQuery("DELETE", "/v1/recipes/a", [{ key: "confirm", value: "a" }]),
    ).resolves.toBeUndefined();
    await expect(
      requestWithQuery("GET", "/v1/recipes/a", [{ key: "confirm", value: "a" }]),
    ).resolves.toEqual({ id: "ok" });
  });

  it("surfaces the product error envelope, e.g. a missing confirmation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          400,
          {
            code: "confirmation_required",
            message: "repeat the exact id in ?confirm= to delete 'a'",
            request_id: "rid-1",
          },
          { "x-request-id": "rid-1" },
        ),
      ),
    );
    const error = await requestWithQuery("DELETE", "/v1/recipes/a", []).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("confirmation_required");
    expect((error as ApiError).requestId).toBe("rid-1");
  });

  const rejectedParams: [string, { key: string; value: string }][] = [
    ["an uppercase value", { key: "confirm", value: "My-Recipe" }],
    ["a value with a space", { key: "confirm", value: "my recipe" }],
    ["a value with a slash", { key: "confirm", value: "../x" }],
    ["a value with a dot", { key: "confirm", value: "a.b" }],
    ["an empty value", { key: "confirm", value: "" }],
    ["an uppercase key", { key: "Confirm", value: "a" }],
    ["a key with a dash", { key: "conf-irm", value: "a" }],
    ["a value that looks encoded", { key: "confirm", value: "a%2fb" }],
  ];

  for (const [label, param] of rejectedParams) {
    it(`rejects ${label} without calling fetch`, async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const error = await requestWithQuery("DELETE", "/v1/recipes/a", [param]).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("invalid_path");
      expect(fetchMock).not.toHaveBeenCalled();
      expect((error as ApiError).message).not.toContain(TOKEN);
    });
  }

  it("still rejects a bad path even with valid parameters", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const error = await requestWithQuery("DELETE", "/v1/../x", [
      { key: "confirm", value: "a" },
    ]).catch((e: unknown) => e);
    expect((error as ApiError).code).toBe("invalid_path");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("requestText (plain-text responses)", () => {
  it("returns the raw text of a successful response, token only in the header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, "id: my-recipe\nname: Mine\n"));
    vi.stubGlobal("fetch", fetchMock);
    const text = await requestText("GET", "/v1/recipes/my-recipe/export");
    expect(text).toBe("id: my-recipe\nname: Mine\n");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/recipes/my-recipe/export");
    expect(String(url)).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("returns an empty string for a 204", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(204, "")));
    await expect(requestText("GET", "/v1/recipes/a/export")).resolves.toBe("");
  });

  it("throws the product error envelope for a non-2xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          404,
          { code: "recipe_not_found", message: "no recipe with that id", request_id: "rid-2" },
          { "x-request-id": "rid-2" },
        ),
      ),
    );
    const error = await requestText("GET", "/v1/recipes/nope/export").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("recipe_not_found");
    expect((error as ApiError).requestId).toBe("rid-2");
  });

  it("rejects a non-API path before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const error = await requestText("GET", "/etc/passwd").catch((e: unknown) => e);
    expect((error as ApiError).code).toBe("invalid_path");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
