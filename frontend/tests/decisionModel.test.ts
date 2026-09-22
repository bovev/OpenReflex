import { describe, expect, it } from "vitest";
import {
  DECISION_INPUT_LIMITS,
  analyzeDecisionInput,
  preflightWarnings,
} from "../src/decisionModel";
import { classifyFailure, failureSummary } from "../src/decisionApi";
import { ApiError } from "../src/api";
import type { Recipe } from "../src/recipeModel";

const RECIPE: Recipe = {
  schema_version: 1,
  id: "test-recipe",
  name: "Test",
  description: "A test recipe",
  model_profile: "typed-decisions",
  questions: {
    department: {
      type: "choice",
      instructions: "Which department?",
      min_confidence: null,
      criteria: { sales: "Pricing", finance: "Invoices" },
    },
    urgency: {
      type: "score",
      instructions: "How urgent?",
      min_confidence: null,
      criteria: ["low", "normal", "high"],
    },
    urgent: { type: "noul", instructions: "Urgent?", min_confidence: null },
  },
  review_policy: { default_min_confidence: 0.8, on_low_confidence: "needs_review" },
};

function choiceRecipe(optionCount: number): Recipe {
  const criteria: Record<string, string> = {};
  for (let i = 0; i < optionCount; i += 1) {
    criteria[`opt_${i}`] = `Option ${i}`;
  }
  return {
    ...RECIPE,
    questions: { pick: { type: "choice", instructions: "Pick?", min_confidence: null, criteria } },
  };
}

describe("analyzeDecisionInput (text mode)", () => {
  it("rejects empty and whitespace-only text", () => {
    expect(analyzeDecisionInput("text", "").issues).toEqual([
      { location: "input", message: "must not be empty" },
    ]);
    expect(analyzeDecisionInput("text", "   ").issues.length).toBe(1);
  });

  it("accepts ordinary text, including path- and URL-looking strings, as inert content", () => {
    expect(analyzeDecisionInput("text", "C:\\Users\\me\\file.txt").issues).toEqual([]);
    expect(analyzeDecisionInput("text", "https://example.com/some/deep/path").issues).toEqual([]);
    expect(analyzeDecisionInput("text", "please decide for me").issues).toEqual([]);
  });

  it("enforces the service's serialized-size bound on text (as the state object)", () => {
    // The service serializes text as the state object {"text": "..."}; the
    // wrapper is 12 UTF-8 bytes, so the bounds are measured on that.
    const over = "x".repeat(DECISION_INPUT_LIMITS.maxSerializedBytes + 1);
    expect(analyzeDecisionInput("text", over).issues.length).toBe(1);
    const under = "x".repeat(DECISION_INPUT_LIMITS.maxSerializedBytes - 12);
    expect(analyzeDecisionInput("text", under).issues).toEqual([]);
    expect(analyzeDecisionInput("text", under).stats.sizeBytes).toBe(
      DECISION_INPUT_LIMITS.maxSerializedBytes,
    );
  });
});

describe("analyzeDecisionInput (json mode)", () => {
  it("rejects malformed JSON without echoing the content", () => {
    const analysis = analyzeDecisionInput("json", '{"a": not-json');
    expect(analysis.issues).toEqual([{ location: "input", message: "is not valid JSON" }]);
    expect(analysis.issues[0].message).not.toContain("not-json");
  });

  it("rejects non-object JSON and empty objects", () => {
    expect(analyzeDecisionInput("json", "[1, 2]").issues).toEqual([
      { location: "input", message: "must be a JSON object" },
    ]);
    expect(analyzeDecisionInput("json", "42").issues).toEqual([
      { location: "input", message: "must be a JSON object" },
    ]);
    expect(analyzeDecisionInput("json", "null").issues).toEqual([
      { location: "input", message: "must be a JSON object" },
    ]);
    expect(analyzeDecisionInput("json", "{}").issues).toEqual([
      { location: "input", message: "must not be empty" },
    ]);
  });

  it("accepts a valid object and mirrors the service's depth bound (root is depth 1)", () => {
    // ``nest(n)`` is ``n`` nested objects; the leaf sits at depth ``n + 1``.
    function nest(levels: number): unknown {
      let value: unknown = "leaf";
      for (let i = 0; i < levels; i += 1) {
        value = { [`l${i}`]: value };
      }
      return value;
    }
    // Seven objects: the leaf is at depth 8, which the service allows
    // (it rejects only depth > 8).
    const ok = analyzeDecisionInput("json", JSON.stringify(nest(7)));
    expect(ok.issues).toEqual([]);
    expect(ok.stats.depth).toBe(8);
    // Eight objects: the leaf is at depth 9, which the service rejects.
    const bad = analyzeDecisionInput("json", JSON.stringify(nest(8)));
    expect(bad.issues).toEqual([
      { location: "input", message: `nesting exceeds ${DECISION_INPUT_LIMITS.maxDepth} levels` },
    ]);
  });

  it("mirrors the service's field-count bound", () => {
    const fields = Object.fromEntries(
      Array.from({ length: DECISION_INPUT_LIMITS.maxFields }, (_, i) => [`k${i}`, i]),
    );
    expect(analyzeDecisionInput("json", JSON.stringify(fields)).issues).toEqual([]);
    const oneMore = { ...fields, extra: true };
    const bad = analyzeDecisionInput("json", JSON.stringify(oneMore));
    expect(bad.issues).toEqual([
      { location: "input", message: `has more than ${DECISION_INPUT_LIMITS.maxFields} fields` },
    ]);
  });

  it("mirrors the service's serialized-size bound (UTF-8 bytes, non-ASCII preserved)", () => {
    // U+20AC is 3 UTF-8 bytes and survives the service's
    // ensure_ascii=False serialization verbatim.
    const over = JSON.stringify({ text: "\u20ac".repeat(Math.floor(DECISION_INPUT_LIMITS.maxSerializedBytes / 3) + 1) });
    expect(analyzeDecisionInput("json", over).issues.length).toBe(1);
    const under = JSON.stringify({ text: "\u20ac".repeat(Math.floor(DECISION_INPUT_LIMITS.maxSerializedBytes / 6)) });
    expect(analyzeDecisionInput("json", under).issues).toEqual([]);
    expect(analyzeDecisionInput("json", under).stats.sizeBytes).toBeLessThanOrEqual(
      DECISION_INPUT_LIMITS.maxSerializedBytes,
    );
  });

  it("counts array items as fields, like the service", () => {
    const items = Array.from({ length: DECISION_INPUT_LIMITS.maxFields }, (_, i) => i);
    const bad = analyzeDecisionInput("json", JSON.stringify({ list: items }));
    expect(bad.issues).toEqual([
      { location: "input", message: `has more than ${DECISION_INPUT_LIMITS.maxFields} fields` },
    ]);
  });
});

describe("preflightWarnings", () => {
  it("warns about high-cardinality choices above the recommended 20, and not at 20", () => {
    const high = preflightWarnings({ mode: "text", text: "x", recipe: choiceRecipe(21) });
    expect(high.map((w) => w.code)).toContain("high_cardinality_choice");
    expect(high.find((w) => w.code === "high_cardinality_choice")?.message).toMatch(/21 options/);
    const at = preflightWarnings({ mode: "text", text: "x", recipe: choiceRecipe(20) });
    expect(at.map((w) => w.code)).not.toContain("high_cardinality_choice");
  });

  it("warns about ordinal score questions", () => {
    const warnings = preflightWarnings({ mode: "text", text: "x", recipe: RECIPE });
    expect(warnings.map((w) => w.code)).toContain("ordinal_question");
    const noulOnly = preflightWarnings({
      mode: "text",
      text: "x",
      recipe: { ...RECIPE, questions: { urgent: RECIPE.questions.urgent } },
    });
    expect(noulOnly.map((w) => w.code)).not.toContain("ordinal_question");
  });

  it("warns about inputs close to the documented size and field limits", () => {
    const near = "x".repeat(Math.ceil(DECISION_INPUT_LIMITS.maxSerializedBytes * 0.95) - 10);
    const sizeWarning = preflightWarnings({ mode: "text", text: near, recipe: null });
    expect(sizeWarning.map((w) => w.code)).toContain("near_size_limit");
    const small = preflightWarnings({ mode: "text", text: "short", recipe: null });
    expect(small.map((w) => w.code)).not.toContain("near_size_limit");

    const fields = Object.fromEntries(
      Array.from({ length: 460 }, (_, i) => [`k${i}`, i]),
    );
    const fieldWarning = preflightWarnings({ mode: "json", text: JSON.stringify(fields), recipe: null });
    expect(fieldWarning.map((w) => w.code)).toContain("near_field_limit");
  });

  it("warns about a valid depth-8 input (close to the nesting limit), and not at depth 7", () => {
    // ``nest(n)`` is ``n`` nested objects; the leaf sits at depth ``n + 1``.
    function nest(levels: number): unknown {
      let value: unknown = "leaf";
      for (let i = 0; i < levels; i += 1) {
        value = { [`l${i}`]: value };
      }
      return value;
    }
    // Seven objects: the leaf is at depth 8, the maximum the service
    // allows - close to the documented limit, so a warning is shown.
    const atLimit = preflightWarnings({
      mode: "json",
      text: JSON.stringify(nest(7)),
      recipe: null,
    });
    expect(atLimit.map((w) => w.code)).toContain("near_depth_limit");
    expect(atLimit.find((w) => w.code === "near_depth_limit")?.message).toMatch(
      /8-level nesting limit/i,
    );
    // Six objects: the leaf is at depth 7, comfortably below the limit.
    const below = preflightWarnings({
      mode: "json",
      text: JSON.stringify(nest(6)),
      recipe: null,
    });
    expect(below.map((w) => w.code)).not.toContain("near_depth_limit");
    // Text input is depth 1: no depth warning.
    const text = preflightWarnings({ mode: "text", text: "x", recipe: null });
    expect(text.map((w) => w.code)).not.toContain("near_depth_limit");
  });

  it("does not warn for a clean, small input", () => {
    const warnings = preflightWarnings({
      mode: "text",
      text: "Should I send this email now?",
      recipe: { ...RECIPE, questions: { urgent: RECIPE.questions.urgent } },
    });
    expect(warnings).toEqual([]);
  });
});

describe("diagnostics safety", () => {
  it("the failure summary never carries input, answer, or result content", () => {
    const sentinel = "SENTINEL-CONTENT-42";
    const info = classifyFailure(
      new ApiError(422, "invalid_input", "the input was rejected", "rid-5", [
        { location: "input", message: "is empty" },
      ]),
    );
    const summary = failureSummary(info);
    expect(summary).toBe("decision failed: kind=validation request_id=rid-5 issues=1");
    expect(summary).not.toContain(sentinel);
    expect(summary).not.toContain("rejected");
  });
});
