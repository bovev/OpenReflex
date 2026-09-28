import { describe, expect, it } from "vitest";
import {
  checkInertText,
  formFromRecipe,
  groupIssues,
  newRecipeForm,
  toPayload,
  validateForm,
  type Recipe,
  type RecipeForm,
} from "../src/recipeModel";

function validForm(): RecipeForm {
  const form = newRecipeForm();
  form.id = "my-recipe";
  form.name = "Mine";
  form.questions[0].id = "urgent";
  form.questions[0].instructions = "Urgent?";
  return form;
}

function choiceForm(): RecipeForm {
  const form = validForm();
  form.questions = [
    {
      id: "department",
      type: "choice",
      instructions: "Which department?",
      minConfidence: "",
      options: [
        { key: "sales", description: "Pricing" },
        { key: "finance", description: "Invoices" },
      ],
      levels: [],
    },
  ];
  return form;
}

describe("newRecipeForm", () => {
  it("starts with the service defaults and one empty true/false question", () => {
    const form = newRecipeForm();
    expect(form.modelProfile).toBe("typed-decisions");
    expect(form.defaultMinConfidence).toBe("0.8");
    expect(form.questions).toHaveLength(1);
    expect(form.questions[0].type).toBe("noul");
  });
});

describe("toPayload", () => {
  it("builds exactly the schema-version-1 fields, nothing else", () => {
    const payload = toPayload(validForm());
    expect(Object.keys(payload).sort()).toEqual(
      ["description", "id", "model_profile", "name", "questions", "review_policy", "schema_version"].sort(),
    );
    expect(payload.schema_version).toBe(1);
    expect(Object.keys(payload.review_policy as Record<string, unknown>).sort()).toEqual([
      "default_min_confidence",
      "on_low_confidence",
    ]);
  });

  it("carries the form's question, option, and level order", () => {
    const form = validForm();
    form.questions = [
      {
        id: "second",
        type: "noul",
        instructions: "Second",
        minConfidence: "0.5",
        options: [],
        levels: [],
      },
      {
        id: "first",
        type: "choice",
        instructions: "First",
        minConfidence: "",
        options: [
          { key: "b", description: "B" },
          { key: "a", description: "A" },
        ],
        levels: [],
      },
    ];
    const payload = toPayload(form);
    expect(Object.keys(payload.questions as Record<string, unknown>)).toEqual(["second", "first"]);
    const first = (payload.questions as Record<string, Record<string, unknown>>).first;
    expect(Object.keys(first.criteria as Record<string, unknown>)).toEqual(["b", "a"]);
    expect(first.min_confidence).toBe(null);
    const second = (payload.questions as Record<string, Record<string, unknown>>).second;
    expect(second.min_confidence).toBe(0.5);
  });

  it("sends the score levels in order and the review policy", () => {
    const form = validForm();
    form.questions = [
      {
        id: "priority",
        type: "score",
        instructions: "How important?",
        minConfidence: "",
        options: [],
        levels: ["low", "normal", "high"],
      },
    ];
    const payload = toPayload(form);
    const question = (payload.questions as Record<string, Record<string, unknown>>).priority;
    expect(question.criteria).toEqual(["low", "normal", "high"]);
    expect(payload.review_policy).toEqual({
      default_min_confidence: 0.8,
      on_low_confidence: "needs_review",
    });
  });

  it("refuses to build a payload with a duplicate question id, so no question is discarded", () => {
    const form = validForm();
    form.questions = [
      {
        id: "urgent",
        type: "noul",
        instructions: "Urgent?",
        minConfidence: "",
        options: [],
        levels: [],
      },
      {
        id: "urgent",
        type: "noul",
        instructions: "Urgent again (must not overwrite the first)",
        minConfidence: "",
        options: [],
        levels: [],
      },
    ];
    expect(() => toPayload(form)).toThrow(/duplicate question id: urgent/);
  });
});

describe("formFromRecipe", () => {
  it("preserves the question and option order and the thresholds", () => {
    const recipe: Recipe = {
      schema_version: 1,
      id: "my-recipe",
      name: "Mine",
      description: "desc",
      model_profile: "english",
      questions: {
        b: {
          type: "choice",
          instructions: "Pick",
          min_confidence: 0.5,
          criteria: { z: "Z", a: "A" },
        },
        a: { type: "noul", instructions: "Bool", min_confidence: null },
      },
      review_policy: { default_min_confidence: 0.9, on_low_confidence: "needs_review" },
    };
    const form = formFromRecipe(recipe);
    expect(form.questions.map((q) => q.id)).toEqual(["b", "a"]);
    expect(form.questions[0].options.map((o) => o.key)).toEqual(["z", "a"]);
    expect(form.questions[0].minConfidence).toBe("0.5");
    expect(form.questions[1].minConfidence).toBe("");
    expect(form.defaultMinConfidence).toBe("0.9");
    expect(form.modelProfile).toBe("english");
  });
});

describe("validateForm", () => {
  it("accepts a valid form", () => {
    expect(validateForm(validForm()).issues).toEqual([]);
  });

  it("rejects an invalid recipe id", () => {
    for (const id of ["Bad Id", "UP", "a..b", "", "-lead", "trail-"]) {
      const form = validForm();
      form.id = id;
      const { issues } = validateForm(form);
      expect(issues.some((issue) => issue.location === "id"), id).toBe(true);
    }
  });

  it("rejects a duplicate of the original id in duplicate mode", () => {
    const { issues } = validateForm(validForm(), "my-recipe");
    expect(issues.some((issue) => issue.location === "id")).toBe(true);
  });

  it("rejects an out-of-range review threshold", () => {
    const form = validForm();
    form.defaultMinConfidence = "1.5";
    const { issues } = validateForm(form);
    expect(issues.some((i) => i.location === "review_policy.default_min_confidence")).toBe(true);
  });

  it("rejects a missing name and an over-long description", () => {
    const form = validForm();
    form.name = "";
    form.description = "x".repeat(501);
    const { issues } = validateForm(form);
    expect(issues.some((i) => i.location === "name")).toBe(true);
    expect(issues.some((i) => i.location === "description")).toBe(true);
  });

  it("rejects zero questions and more than 20 questions", () => {
    const form = validForm();
    form.questions = [];
    expect(validateForm(form).issues.some((i) => i.location === "questions")).toBe(true);
    for (let i = 0; i < 21; i += 1) {
      form.questions.push({
        id: `q${i}`,
        type: "noul",
        instructions: "I",
        minConfidence: "",
        options: [],
        levels: [],
      });
    }
    expect(validateForm(form).issues.some((i) => i.location === "questions")).toBe(true);
  });

  it("rejects an invalid question id and missing instructions", () => {
    const form = validForm();
    form.questions[0].id = "Urgent";
    form.questions[0].instructions = "";
    const { issues } = validateForm(form);
    expect(issues.some((i) => i.location === "questions.Urgent")).toBe(true);
    expect(issues.some((i) => i.location === "questions.Urgent.instructions")).toBe(true);
  });

  it("rejects duplicate question ids before any payload is built", () => {
    const form = validForm();
    form.questions.push({
      id: "urgent",
      type: "noul",
      instructions: "Urgent again",
      minConfidence: "",
      options: [],
      levels: [],
    });
    const { issues } = validateForm(form);
    expect(
      issues.some((i) => i.location === "questions.urgent" && i.message === "question ids must be unique"),
    ).toBe(true);
  });

  it("rejects a choice with one option, an invalid option key, and duplicate keys", () => {
    const form = choiceForm();
    form.questions[0].options = [{ key: "Sales!", description: "Pricing" }];
    let { issues } = validateForm(form);
    expect(issues.some((i) => i.location === "questions.department.criteria")).toBe(true);
    form.questions[0].options = [
      { key: "sales", description: "Pricing" },
      { key: "sales", description: "Again" },
    ];
    ({ issues } = validateForm(form));
    expect(issues.some((i) => i.location === "questions.department.criteria.sales")).toBe(true);
  });

  it("warns above the recommended option count and rejects more than 50 options", () => {
    const form = choiceForm();
    form.questions[0].options = Array.from({ length: 21 }, (_, i) => ({
      key: `opt${i}`,
      description: `D${i}`,
    }));
    let result = validateForm(form);
    expect(result.issues).toEqual([]);
    expect(result.warnings.join(" ")).toContain("21 options");
    form.questions[0].options = Array.from({ length: 51 }, (_, i) => ({
      key: `opt${i}`,
      description: `D${i}`,
    }));
    result = validateForm(form);
    expect(result.issues.some((i) => i.location === "questions.department.criteria")).toBe(true);
  });

  it("rejects score levels that are too few, too many, or not distinct", () => {
    const form = validForm();
    form.questions[0] = {
      id: "priority",
      type: "score",
      instructions: "I",
      minConfidence: "",
      options: [],
      levels: ["only-one"],
    };
    let { issues } = validateForm(form);
    expect(issues.some((i) => i.location === "questions.priority.criteria")).toBe(true);
    // The duplicate is detected at the second occurrence.
    form.questions[0].levels = ["low", "low"];
    ({ issues } = validateForm(form));
    expect(issues.some((i) => i.location === "questions.priority.criteria.1")).toBe(true);
    form.questions[0].levels = Array.from({ length: 11 }, (_, i) => `l${i}`);
    ({ issues } = validateForm(form));
    expect(issues.some((i) => i.location === "questions.priority.criteria")).toBe(true);
  });

  it("rejects inert-text violations before submission", () => {
    const form = validForm();
    form.questions[0].instructions = "See https://example.com for details";
    expect(validateForm(form).issues.some((i) => i.location === "questions.urgent.instructions")).toBe(
      true,
    );
    form.questions[0].instructions = "Use {{template}} here";
    expect(validateForm(form).issues.some((i) => i.location === "questions.urgent.instructions")).toBe(
      true,
    );
  });
});

describe("checkInertText", () => {
  it("accepts ordinary text, including path- or URL-looking inert strings", () => {
    expect(checkInertText("C:\\Users\\me\\file.txt")).toBe(null);
    expect(checkInertText("the score is 50% of the total")).toBe(null);
  });

  it("rejects template, environment-variable, URL, and control characters", () => {
    expect(checkInertText("a {{x}} b")).not.toBe(null);
    expect(checkInertText("a ${x} b")).not.toBe(null);
    expect(checkInertText("%HOME%")).not.toBe(null);
    expect(checkInertText("fetch https://x.example/a")).not.toBe(null);
    expect(checkInertText(`a${String.fromCharCode(7)}b`)).not.toBe(null);
  });
});

describe("groupIssues", () => {
  it("maps top-level, per-question, and unknown locations", () => {
    const form = validForm();
    const grouped = groupIssues(
      [
        { location: "id", message: "bad id" },
        { location: "questions.urgent.instructions", message: "bad instructions" },
        { location: "questions.urgent.criteria.sales", message: "bad option" },
        { location: "schema_version", message: "unknown" },
        { location: "review_policy.default_min_confidence", message: "bad threshold" },
      ],
      form,
    );
    expect(grouped.top.id?.[0]?.message).toBe("bad id");
    expect(grouped.top["review_policy.default_min_confidence"]?.[0]?.message).toBe("bad threshold");
    expect(grouped.questions[0].map((i) => i.location)).toEqual([
      "questions.urgent.instructions",
      "questions.urgent.criteria.sales",
    ]);
    expect(grouped.general.map((i) => i.location)).toEqual(["schema_version"]);
  });

  it("maps a client-side placeholder for an empty question id to its position", () => {
    const form = validForm();
    form.questions[0].id = "";
    const grouped = groupIssues(
      [{ location: "questions.question-1.instructions", message: "client issue" }],
      form,
    );
    expect(grouped.questions[0]).toHaveLength(1);
    expect(grouped.general).toEqual([]);
  });
});
