import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapToken, clearToken } from "../src/token";
import {
  classifyFailure,
  failureSummary,
  runDecision,
} from "../src/decisionApi";
import { ApiError, CanceledError } from "../src/api";

afterEach(() => {
  clearToken();
  vi.unstubAllGlobals();
});

describe("classifyFailure", () => {
  function apiError(status: number, code: string, message: string): ApiError {
    return new ApiError(status, code, message, "rid-1", []);
  }

  it("classifies a canceled request", () => {
    const info = classifyFailure(new CanceledError());
    expect(info.kind).toBe("canceled");
    expect(info.hint).toMatch(/canceled/i);
  });

  it("classifies queue saturation with the service's retry hint", () => {
    const info = classifyFailure(apiError(429, "queue_full", "the decision queue is full; retry shortly"));
    expect(info.kind).toBe("queue_full");
    expect(info.hint).toMatch(/2 seconds/);
  });

  it("classifies model-not-ready, model-not-found, and model-busy separately", () => {
    expect(classifyFailure(apiError(409, "model_not_ready", "x")).kind).toBe("model_not_ready");
    expect(classifyFailure(apiError(404, "model_not_found", "x")).kind).toBe("model_not_found");
    expect(classifyFailure(apiError(409, "model_busy", "x")).kind).toBe("model_busy");
  });

  it("classifies validation failures (invalid input and oversized input)", () => {
    expect(classifyFailure(apiError(422, "invalid_input", "x")).kind).toBe("validation");
    expect(classifyFailure(apiError(413, "input_too_large", "x")).kind).toBe("validation");
  });

  it("classifies recipe-not-found, timeout, and engine failures", () => {
    expect(classifyFailure(apiError(404, "recipe_not_found", "x")).kind).toBe("recipe_not_found");
    expect(classifyFailure(apiError(504, "timeout", "x")).kind).toBe("timeout");
    expect(classifyFailure(apiError(500, "engine_failure", "x")).kind).toBe("engine_failure");
    expect(classifyFailure(apiError(500, "engine_incompatible", "x")).kind).toBe("engine_failure");
    expect(classifyFailure(apiError(500, "internal", "x")).kind).toBe("engine_failure");
  });

  it("classifies a network error and an unknown code safely, without echoing text", () => {
    expect(classifyFailure(apiError(0, "network", "x")).kind).toBe("network");
    const unknown = classifyFailure(apiError(500, "something_new", "SECRET-CONTENT"));
    expect(unknown.kind).toBe("failure");
    expect(unknown.message).toBe("SECRET-CONTENT"); // the service's own safe message
    const foreign = classifyFailure(new Error("SECRET-CONTENT"));
    expect(foreign.kind).toBe("failure");
    expect(foreign.message).toBe("the decision failed");
    expect(foreign.message).not.toContain("SECRET-CONTENT");
  });

  it("keeps request ids and issues, and the summary stays free of content", () => {
    const info = classifyFailure(
      new ApiError(422, "invalid_input", "the input was rejected", "rid-9", [
        { location: "input", message: "is empty" },
      ]),
    );
    expect(info.requestId).toBe("rid-9");
    expect(info.issues).toEqual([{ location: "input", message: "is empty" }]);
    const summary = failureSummary(info);
    expect(summary).toBe("decision failed: kind=validation request_id=rid-9 issues=1");
    expect(summary).not.toContain("rejected");
  });
});

describe("runDecision", () => {
  it("sends exactly the DecisionRequest shape to POST /v1/decisions, once, and never fetches the input", async () => {
    window.location.hash = "#token=tok-decision-api-1";
    bootstrapToken();
    const fetchMock = vi.fn((_input: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () =>
          Promise.resolve(
            JSON.stringify({
              request_id: "rid-d1",
              recipe_id: "my-recipe",
              status: "completed",
              review: "ok",
              model: {
                profile: "typed-decisions",
                resolved_profile: "typed-decisions",
                checkpoint: "ckpt",
                revision: "rev-1",
                device: "fake",
              },
              answers: {},
              warnings: [],
              timing_ms: 1,
              contract_version: 1,
            }),
          ),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const inert = "https://example.com/never-fetched";
    const result = await runDecision({ recipe_id: "my-recipe", input: inert });
    expect(result.request_id).toBe("rid-d1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/v1/decisions");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ recipe_id: "my-recipe", input: inert });
    // The input travels in the body only; no request target derives from it.
    expect(String(url)).not.toContain("example.com");
  });

  it("reports a failure exactly once: no implicit retry", async () => {
    window.location.hash = "#token=tok-decision-api-2";
    bootstrapToken();
    const fetchMock = vi.fn((_input: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: false,
        status: 429,
        headers: { get: () => null },
        text: () =>
          Promise.resolve(
            JSON.stringify({
              code: "queue_full",
              message: "the decision queue is full; retry shortly",
              request_id: "rid-d2",
              issues: [],
            }),
          ),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(runDecision({ recipe_id: "my-recipe", input: "x" })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
