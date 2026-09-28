import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionScreen } from "../src/decision";
import { bootstrapToken, clearToken } from "../src/token";
import type { Recipe, RecipeSummary } from "../src/recipeModel";
import type { DecisionResult } from "../src/decisionApi";

const TOKEN = "tok-decision-123";

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

const SUMMARIES: readonly RecipeSummary[] = [
  {
    id: "my-recipe",
    name: "Mine",
    description: "A test recipe",
    model_profile: "typed-decisions",
    question_count: 2,
    example: false,
  },
];

const RECIPE: Recipe = {
  schema_version: 1,
  id: "my-recipe",
  name: "Mine",
  description: "A test recipe",
  model_profile: "typed-decisions",
  questions: {
    department: {
      type: "choice",
      instructions: "Which department?",
      min_confidence: null,
      criteria: { sales: "Pricing", finance: "Invoices" },
    },
    urgent: { type: "noul", instructions: "Urgent?", min_confidence: null },
  },
  review_policy: { default_min_confidence: 0.8, on_low_confidence: "needs_review" },
};

function modelInfo(): DecisionResult["model"] {
  return {
    profile: "typed-decisions",
    resolved_profile: "typed-decisions",
    checkpoint: "checkpoint-abc",
    revision: "revision-123",
    device: "fake",
  };
}

function resultWith(overrides: Partial<DecisionResult>): DecisionResult {
  return {
    request_id: "rid-result-1",
    recipe_id: "my-recipe",
    status: "completed",
    review: "ok",
    model: modelInfo(),
    answers: {},
    warnings: [],
    timing_ms: 184.2,
    contract_version: 1,
    ...overrides,
  };
}

type FetchHandler = (
  method: string,
  url: string,
  body: unknown,
  signal: AbortSignal | null,
) => Response | Promise<Response>;

interface Rendered {
  fetchMock: ReturnType<typeof vi.fn>;
}

function renderDecision(onFetch: FetchHandler): Promise<Rendered> {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    return Promise.resolve(onFetch(method, input, body, init?.signal ?? null));
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<DecisionScreen />);
  return Promise.resolve({ fetchMock });
}

function postCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      url === "/v1/decisions" && ((init as RequestInit | undefined)?.method ?? "GET") === "POST",
  ).length;
}

function lastPostBody(fetchMock: ReturnType<typeof vi.fn>): unknown {
  const calls = fetchMock.mock.calls.filter(
    ([url, init]) =>
      url === "/v1/decisions" && ((init as RequestInit | undefined)?.method ?? "GET") === "POST",
  );
  const init = calls.at(-1)?.[1] as RequestInit | undefined;
  return typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
}

/** Select the recipe and type the input. */
async function selectAndType(_fetchMock: ReturnType<typeof vi.fn>, input: string): Promise<void> {
  await vi.waitFor(() => expect(screen.getByTestId("recipe-select")).toBeTruthy());
  fireEvent.change(screen.getByTestId("recipe-select"), { target: { value: "my-recipe" } });
  fireEvent.change(screen.getByTestId("decision-input"), { target: { value: input } });
}

beforeEach(() => {
  window.location.hash = `#token=${TOKEN}`;
  bootstrapToken();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearToken();
});

describe("decision screen", () => {
  it("lists recipes and submits exactly the DecisionRequest shape as inert text", async () => {
    const { fetchMock } = await renderDecision((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: SUMMARIES, invalid: [] });
      }
      if (method === "GET" && url === "/v1/recipes/my-recipe") {
        return jsonResponse(200, RECIPE);
      }
      if (method === "POST" && url === "/v1/decisions") {
        return jsonResponse(200, resultWith({}));
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    // A URL-looking string is accepted as inert content.
    const inert = "https://example.com/never-fetched";
    await selectAndType(fetchMock, inert);
    screen.getByTestId("run-decision").click();
    await vi.waitFor(() => expect(screen.getByTestId("decision-result")).toBeTruthy());

    const body = lastPostBody(fetchMock);
    expect(body).toEqual({ recipe_id: "my-recipe", input: inert });
    // The input is carried in the body only: no request target derives from it.
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain("example.com");
    }
    // The inert note is shown.
    expect(screen.getByTestId("input-note").textContent).toMatch(/never opened/i);
  });

  it("renders the complete result for every primitive, with checkpoint, revision, and latency", async () => {
    const { fetchMock } = await renderDecision((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: SUMMARIES, invalid: [] });
      }
      if (method === "GET" && url === "/v1/recipes/my-recipe") {
        return jsonResponse(200, RECIPE);
      }
      if (method === "POST" && url === "/v1/decisions") {
        return jsonResponse(
          200,
          resultWith({
            answers: {
              department: {
                type: "choice",
                choice: "sales",
                probability: 0.7,
                confidence: 0.85,
                probabilities: { sales: 0.7, finance: 0.3 },
                review: "ok",
              },
              urgency: {
                type: "score",
                score: 1.5,
                level: 1,
                label: "normal",
                probability: 0.5,
                confidence: 0.75,
                probabilities: [0.2, 0.5, 0.3],
                review: "ok",
              },
              urgent: {
                type: "noul",
                value: true,
                probability_true: 0.6,
                confidence: 0.9,
                review: "ok",
              },
            },
          }),
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await selectAndType(fetchMock, "should I send this email now?");
    screen.getByTestId("run-decision").click();
    await vi.waitFor(() => expect(screen.getByTestId("decision-result")).toBeTruthy());

    // Envelope fields, including the actual checkpoint and pinned revision.
    expect(screen.getByTestId("result-status").textContent).toBe("completed");
    expect(screen.getByTestId("result-checkpoint").textContent).toBe("checkpoint-abc");
    expect(screen.getByTestId("result-revision").textContent).toBe("revision-123");
    expect(screen.getByTestId("result-resolved-profile").textContent).toBe("typed-decisions");
    expect(screen.getByTestId("result-device").textContent).toBe("fake");
    expect(screen.getByTestId("result-contract").textContent).toBe("1");
    expect(screen.getByTestId("result-request-id").textContent).toBe("rid-result-1");
    expect(screen.getByTestId("result-timing").textContent).toBe("184.2 ms");

    // Choice answer: chosen option, probability, confidence, distribution.
    // Raw values are shown at the service's precision, with an approximate
    // percentage alongside.
    const choice = screen.getByTestId("answer-department");
    expect(choice.textContent).toContain("Chosen option: sales");
    expect(choice.textContent).toContain("Probability of the chosen option: 0.7 (≈ 70.0%)");
    expect(choice.textContent).toContain(
      "Engine confidence (what the review policy uses): 0.85 (≈ 85.0%)",
    );
    expect(screen.getByTestId("answer-department-distribution").textContent).toContain(
      "sales: 0.7 (≈ 70.0%)",
    );
    expect(screen.getByTestId("answer-department-distribution").textContent).toContain(
      "finance: 0.3 (≈ 30.0%)",
    );
    expect(screen.getByTestId("answer-department-review").textContent).toBe("ok");

    // Score answer: score, level, label, probability, confidence, per-level distribution.
    const score = screen.getByTestId("answer-urgency");
    expect(score.textContent).toContain("Score: 1.5 - level 1: normal");
    expect(score.textContent).toContain("Probability of the level: 0.5 (≈ 50.0%)");
    expect(score.textContent).toContain(
      "Engine confidence (what the review policy uses): 0.75 (≈ 75.0%)",
    );
    const distribution = screen.getByTestId("answer-urgency-distribution").textContent;
    expect(distribution).toContain("level 0: 0.2 (≈ 20.0%)");
    expect(distribution).toContain("level 1: 0.5 (≈ 50.0%)");
    expect(distribution).toContain("level 2: 0.3 (≈ 30.0%)");
    expect(screen.getByTestId("answer-urgency-review").textContent).toBe("ok");

    // Noul answer: value, probability of true, confidence.
    const noul = screen.getByTestId("answer-urgent");
    expect(noul.textContent).toContain("Value: true");
    expect(noul.textContent).toContain("Probability of true: 0.6 (≈ 60.0%)");
    expect(noul.textContent).toContain(
      "Engine confidence (what the review policy uses): 0.9 (≈ 90.0%)",
    );
    expect(screen.getByTestId("answer-urgent-review").textContent).toBe("ok");

    // Review state is a separate block from the probabilities.
    expect(screen.getByTestId("result-review-state").textContent).toContain("Ok");
    expect(screen.getByTestId("result-no-warnings").textContent).toBe("No warnings.");
  });

  it("shows probabilities at the service's precision, not rounded (0.9999 stays 0.9999)", async () => {
    const { fetchMock } = await renderDecision((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: SUMMARIES, invalid: [] });
      }
      if (method === "GET" && url === "/v1/recipes/my-recipe") {
        return jsonResponse(200, RECIPE);
      }
      if (method === "POST" && url === "/v1/decisions") {
        return jsonResponse(
          200,
          resultWith({
            answers: {
              department: {
                type: "choice",
                choice: "sales",
                probability: 0.9999,
                confidence: 0.987654,
                probabilities: { sales: 0.9999, finance: 0.0001 },
                review: "ok",
              },
              urgent: {
                type: "noul",
                value: true,
                probability_true: 0.123456,
                confidence: 0.555555,
                review: "ok",
              },
            },
          }),
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await selectAndType(fetchMock, "x");
    screen.getByTestId("run-decision").click();
    await vi.waitFor(() => expect(screen.getByTestId("decision-result")).toBeTruthy());

    // The raw, high-precision values are shown verbatim.
    const choice = screen.getByTestId("answer-department");
    expect(choice.textContent).toContain("Probability of the chosen option: 0.9999 (≈ 100.0%)");
    expect(choice.textContent).toContain(
      "Engine confidence (what the review policy uses): 0.987654 (≈ 98.8%)",
    );
    const distribution = screen.getByTestId("answer-department-distribution").textContent;
    expect(distribution).toContain("sales: 0.9999 (≈ 100.0%)");
    expect(distribution).toContain("finance: 0.0001 (≈ 0.0%)");

    const noul = screen.getByTestId("answer-urgent");
    expect(noul.textContent).toContain("Probability of true: 0.123456 (≈ 12.3%)");
    expect(noul.textContent).toContain(
      "Engine confidence (what the review policy uses): 0.555555 (≈ 55.6%)",
    );

    // A near-1 value is never collapsed to the rounded "100%" as the raw value.
    expect(choice.textContent).not.toContain("Probability of the chosen option: 1 (");
    expect(choice.textContent).not.toContain("Probability of the chosen option: 100.0%");
  });

  it("blocks malformed JSON locally without sending a request", async () => {
    const { fetchMock } = await renderDecision((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: SUMMARIES, invalid: [] });
      }
      if (method === "GET" && url === "/v1/recipes/my-recipe") {
        return jsonResponse(200, RECIPE);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await selectAndType(fetchMock, "");
    fireEvent.click(screen.getByTestId("input-mode-json"));
    fireEvent.change(screen.getByTestId("decision-input"), { target: { value: '{"a": not-json' } });

    expect(screen.getByTestId("input-issues").textContent).toContain("is not valid JSON");
    expect((screen.getByTestId("run-decision") as HTMLButtonElement).disabled).toBe(true);
    screen.getByTestId("run-decision").click();
    await vi.waitFor(() => expect(screen.queryByTestId("decision-failure")).toBeNull());
    expect(postCalls(fetchMock)).toBe(0);
  });

  it("warns preflight about high-cardinality choices and ordinal questions, without predicting answers", async () => {
    const bigCriteria: Record<string, string> = {};
    for (let i = 0; i < 21; i += 1) {
      bigCriteria[`opt_${i}`] = `Option ${i}`;
    }
    const { fetchMock } = await renderDecision((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: SUMMARIES, invalid: [] });
      }
      if (method === "GET" && url === "/v1/recipes/my-recipe") {
        return jsonResponse(
          200,
          {
            ...RECIPE,
            questions: {
              pick: {
                type: "choice",
                instructions: "Pick?",
                min_confidence: null,
                criteria: bigCriteria,
              },
              urgency: {
                type: "score",
                instructions: "How urgent?",
                min_confidence: null,
                criteria: ["low", "normal", "high"],
              },
            },
          },
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await selectAndType(fetchMock, "x");
    await vi.waitFor(() => expect(screen.getByTestId("preflight-warnings")).toBeTruthy());
    expect(screen.getByTestId("preflight-high_cardinality_choice").textContent).toMatch(/21 options/);
    expect(screen.getByTestId("preflight-ordinal_question")).toBeTruthy();
    expect(screen.getByTestId("preflight-disclaimer").textContent).toMatch(
      /do not predict the model's answers/i,
    );
  });

  it("renders needs_review separately from probability, with the standing not-correctness note", async () => {
    const { fetchMock } = await renderDecision((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: SUMMARIES, invalid: [] });
      }
      if (method === "GET" && url === "/v1/recipes/my-recipe") {
        return jsonResponse(200, RECIPE);
      }
      if (method === "POST" && url === "/v1/decisions") {
        return jsonResponse(
          200,
          resultWith({
            review: "needs_review",
            answers: {
              urgent: {
                type: "noul",
                value: false,
                probability_true: 0.4,
                confidence: 0.55,
                review: "needs_review",
              },
            },
            warnings: [
              {
                code: "low_confidence",
                message: "Confidence 0.55 is below this question's review threshold of 0.80.",
                question_id: "urgent",
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await selectAndType(fetchMock, "is this urgent?");
    screen.getByTestId("run-decision").click();
    await vi.waitFor(() => expect(screen.getByTestId("decision-result")).toBeTruthy());

    // The review block is separate from the probability block.
    const reviewBlock = screen.getByTestId("result-review");
    expect(reviewBlock.textContent).toContain("Needs review");
    expect(reviewBlock.textContent).toMatch(/not a claim that the answers are wrong/i);
    expect(reviewBlock.textContent).toMatch(
      /Neither the confidence nor the review state proves correctness/i,
    );
    // The probability is in the answer card, not the review block.
    const answer = screen.getByTestId("answer-urgent");
    expect(answer.textContent).toContain("Probability of true: 0.4 (≈ 40.0%)");
    expect(reviewBlock.textContent).not.toContain("0.4 (≈ 40.0%)");
    expect(screen.getByTestId("answer-urgent-review").textContent).toBe("needs review");
    // The low-confidence warning is rendered.
    expect(screen.getByTestId("warning-low_confidence").textContent).toContain(
      "Confidence 0.55 is below this question's review threshold of 0.80.",
    );
  });

  it("renders every warning, including truncation warnings", async () => {
    const { fetchMock } = await renderDecision((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: SUMMARIES, invalid: [] });
      }
      if (method === "GET" && url === "/v1/recipes/my-recipe") {
        return jsonResponse(200, RECIPE);
      }
      if (method === "POST" && url === "/v1/decisions") {
        return jsonResponse(
          200,
          resultWith({
            review: "needs_review",
            warnings: [
              { code: "input_truncated", message: "The input was truncated.", question_id: null },
              {
                code: "options_truncated",
                message: "The options were truncated.",
                question_id: "department",
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await selectAndType(fetchMock, "x");
    screen.getByTestId("run-decision").click();
    await vi.waitFor(() => expect(screen.getByTestId("decision-result")).toBeTruthy());
    expect(screen.getByTestId("warning-input_truncated").textContent).toContain(
      "The input was truncated.",
    );
    expect(screen.getByTestId("warning-options_truncated").textContent).toContain(
      "The options were truncated.",
    );
    expect(screen.getByTestId("warning-options_truncated").textContent).toContain(
      "question department",
    );
  });

  it("distinguishes queue saturation (with the retry hint) from model-not-ready", async () => {
    let decisionStatus: [number, unknown] = [
      429,
      { code: "queue_full", message: "the decision queue is full; retry shortly", request_id: "rid-q" },
    ];
    const { fetchMock } = await renderDecision((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: SUMMARIES, invalid: [] });
      }
      if (method === "GET" && url === "/v1/recipes/my-recipe") {
        return jsonResponse(200, RECIPE);
      }
      if (method === "POST" && url === "/v1/decisions") {
        return jsonResponse(decisionStatus[0], decisionStatus[1]);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await selectAndType(fetchMock, "x");
    screen.getByTestId("run-decision").click();
    await vi.waitFor(() => expect(screen.getByTestId("decision-failure")).toBeTruthy());
    expect(screen.getByTestId("failure-hint").textContent).toMatch(/2 seconds/);
    expect(screen.getByTestId("failure-message").textContent).toContain("queue is full");
    // No automatic retry: exactly one decision request was issued.
    expect(postCalls(fetchMock)).toBe(1);
    // An explicit user click runs it again (and only then).
    screen.getByTestId("run-decision").click();
    await vi.waitFor(() => expect(postCalls(fetchMock)).toBe(2));
    // Let the second decision settle (running=false) before the next run.
    await vi.waitFor(() =>
      expect((screen.getByTestId("run-decision") as HTMLButtonElement).disabled).toBe(false),
    );

    // Model-not-ready is a distinct state with its own guidance.
    decisionStatus = [
      409,
      { code: "model_not_ready", message: "the model is not ready", request_id: "rid-m" },
    ];
    screen.getByTestId("run-decision").click();
    await vi.waitFor(() =>
      expect(screen.getByTestId("failure-message").textContent).toContain("not ready"),
    );
    expect(screen.getByTestId("failure-hint").textContent).toMatch(/Setup screen/i);
    expect(screen.getByTestId("failure-hint").textContent).not.toMatch(/2 seconds/);
  });

  it("distinguishes timeout, validation, and engine failure", async () => {
    let decisionStatus: [number, unknown] = [
      504,
      { code: "timeout", message: "the decision took too long", request_id: "rid-t" },
    ];
    const { fetchMock } = await renderDecision((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: SUMMARIES, invalid: [] });
      }
      if (method === "GET" && url === "/v1/recipes/my-recipe") {
        return jsonResponse(200, RECIPE);
      }
      if (method === "POST" && url === "/v1/decisions") {
        return jsonResponse(decisionStatus[0], decisionStatus[1]);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await selectAndType(fetchMock, "x");
    screen.getByTestId("run-decision").click();
    await vi.waitFor(() => expect(screen.getByTestId("decision-failure")).toBeTruthy());
    expect(screen.getByTestId("failure-hint").textContent).toMatch(/timeout/i);

    decisionStatus = [
      422,
      {
        code: "invalid_input",
        message: "the input was rejected",
        request_id: "rid-v",
        issues: [{ location: "input", message: "is empty" }],
      },
    ];
    screen.getByTestId("run-decision").click();
    await vi.waitFor(() =>
      expect(screen.getByTestId("failure-message").textContent).toContain("rejected"),
    );
    expect(screen.getByTestId("failure-issues").textContent).toContain("is empty");
    expect(screen.getByTestId("failure-hint").textContent).toMatch(/before the model ran/i);

    decisionStatus = [
      500,
      { code: "engine_failure", message: "the engine failed to produce a decision", request_id: "rid-e" },
    ];
    screen.getByTestId("run-decision").click();
    await vi.waitFor(() =>
      expect(screen.getByTestId("failure-message").textContent).toContain(
        "engine failed to produce a decision",
      ),
    );
    // A failure renders no result.
    expect(screen.queryByTestId("decision-result")).toBeNull();
  });

  it("disables duplicate submissions while a decision is in flight", async () => {
    const gate: { resolve: ((value: Response) => void) | null } = { resolve: null };
    const pending = new Promise<Response>((resolve) => {
      gate.resolve = resolve;
    });
    const { fetchMock } = await renderDecision((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: SUMMARIES, invalid: [] });
      }
      if (method === "GET" && url === "/v1/recipes/my-recipe") {
        return jsonResponse(200, RECIPE);
      }
      if (method === "POST" && url === "/v1/decisions") {
        return pending;
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await selectAndType(fetchMock, "x");
    screen.getByTestId("run-decision").click();
    await vi.waitFor(() => expect(screen.getByTestId("decision-running")).toBeTruthy());
    // The run button is disabled while in flight, so a decision cannot be
    // submitted twice.
    expect((screen.getByTestId("run-decision") as HTMLButtonElement).disabled).toBe(true);
    screen.getByTestId("run-decision").click();
    expect(postCalls(fetchMock)).toBe(1);
    // Resolve the in-flight decision.
    gate.resolve?.(jsonResponse(200, resultWith({})));
    await vi.waitFor(() => expect(screen.getByTestId("decision-result")).toBeTruthy());
    expect(postCalls(fetchMock)).toBe(1);
  });

  it("cancels the client's wait; the service-side work may continue and its result is discarded", async () => {
    // The service's in-flight inference work: it settles only when the
    // (simulated) service finishes - never because the client aborted.
    const service: { resolve: ((value: Response) => void) | null } = { resolve: null };
    const serviceWork = new Promise<Response>((resolve) => {
      service.resolve = resolve;
    });
    const { fetchMock } = await renderDecision((method, url, _body, signal) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: SUMMARIES, invalid: [] });
      }
      if (method === "GET" && url === "/v1/recipes/my-recipe") {
        return jsonResponse(200, RECIPE);
      }
      if (method === "POST" && url === "/v1/decisions") {
        // Simulate a browser fetch: the client's wait rejects on abort,
        // but the service's work (serviceWork) keeps running.
        const aborted = new Promise<Response>((_, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
        return Promise.race([serviceWork, aborted]);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await selectAndType(fetchMock, "x");
    screen.getByTestId("run-decision").click();
    await vi.waitFor(() => expect(screen.getByTestId("cancel-decision")).toBeTruthy());
    screen.getByTestId("cancel-decision").click();
    await vi.waitFor(() => expect(screen.getByTestId("decision-canceled")).toBeTruthy());
    // The copy states the service-side semantics accurately: the work may
    // still be running and may keep its queue slot; nothing was retried.
    expect(screen.getByTestId("decision-canceled").textContent).toMatch(/may still be running/i);
    expect(screen.getByTestId("decision-canceled").textContent).toMatch(/queue slot/i);
    expect(screen.getByTestId("decision-canceled").textContent).toMatch(/nothing was retried/i);
    // Exactly one decision request was issued; no automatic retry.
    expect(postCalls(fetchMock)).toBe(1);
    // The service-side work continues and finishes after the client gave
    // up; its result is discarded, not shown.
    service.resolve?.(jsonResponse(200, resultWith({})));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("decision-result")).toBeNull();
    expect(postCalls(fetchMock)).toBe(1);
  });

  it("keeps input and answer content out of error text, the diagnostic line, and console logs", async () => {
    const inputSentinel = "SENTINEL-INPUT-42";
    const answerSentinel = "SENTINEL-ANSWER-42";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    let decisionStatus: [number, unknown] = [
      422,
      {
        code: "invalid_input",
        message: "the input was rejected",
        request_id: "rid-p",
        issues: [{ location: "input", message: "is empty" }],
      },
    ];
    const { fetchMock } = await renderDecision((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: SUMMARIES, invalid: [] });
      }
      if (method === "GET" && url === "/v1/recipes/my-recipe") {
        return jsonResponse(200, RECIPE);
      }
      if (method === "POST" && url === "/v1/decisions") {
        return jsonResponse(decisionStatus[0], decisionStatus[1]);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await selectAndType(fetchMock, inputSentinel);
    screen.getByTestId("run-decision").click();
    await vi.waitFor(() => expect(screen.getByTestId("decision-failure")).toBeTruthy());

    // Error text and the diagnostic line never carry the input.
    const failure = screen.getByTestId("decision-failure");
    expect(failure.textContent).not.toContain(inputSentinel);
    expect(screen.getByTestId("failure-summary").textContent).toBe(
      "decision failed: kind=validation request_id=rid-p issues=1",
    );

    // A successful result whose answer content carries the sentinel: the
    // sentinel is rendered in the result view, but never reaches console
    // output or the diagnostic/error summary.
    decisionStatus = [
      200,
      resultWith({
        answers: {
          urgency: {
            type: "score",
            score: 1.0,
            level: 1,
            label: answerSentinel,
            probability: 0.5,
            confidence: 0.9,
            probabilities: [0.2, 0.5, 0.3],
            review: "ok",
          },
        },
      }),
    ];
    fireEvent.change(screen.getByTestId("decision-input"), { target: { value: "run again" } });
    screen.getByTestId("run-decision").click();
    await vi.waitFor(() => expect(screen.getByTestId("decision-result")).toBeTruthy());

    // The answer sentinel is rendered in the result view (the label).
    expect(screen.getByTestId("answer-urgency").textContent).toContain(answerSentinel);
    // The earlier failure (and its diagnostic line) is cleared on success:
    // no error/diagnostic summary is present to carry the sentinel.
    expect(screen.queryByTestId("decision-failure")).toBeNull();
    expect(screen.queryByTestId("failure-summary")).toBeNull();

    const allConsoleArgs = [
      ...logSpy.mock.calls.flat(),
      ...errorSpy.mock.calls.flat(),
      ...warnSpy.mock.calls.flat(),
      ...infoSpy.mock.calls.flat(),
    ];
    for (const arg of allConsoleArgs) {
      const text = typeof arg === "string" ? arg : JSON.stringify(arg);
      expect(text).not.toContain(inputSentinel);
      expect(text).not.toContain(answerSentinel);
    }
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });
});
