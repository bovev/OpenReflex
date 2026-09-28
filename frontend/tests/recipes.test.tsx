import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecipesScreen, type LeaveGuard } from "../src/recipes";
import { bootstrapToken, clearToken } from "../src/token";
import type { Recipe, RecipeListing } from "../src/recipeModel";

const TOKEN = "tok-recipes-123";

interface StubHeaders {
  get: (name: string) => string | null;
}

function jsonResponse(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null } as StubHeaders,
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

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

const LISTING: RecipeListing = {
  recipes: [
    {
      id: "email-triage",
      name: "Email triage (example)",
      description: "Demonstration recipe",
      model_profile: "typed-decisions",
      question_count: 3,
      example: true,
    },
    {
      id: "my-recipe",
      name: "Mine",
      description: "A test recipe",
      model_profile: "typed-decisions",
      question_count: 2,
      example: false,
    },
  ],
  invalid: [],
};

type FetchHandler = (
  method: string,
  url: string,
  body: unknown,
) => Response | Promise<Response>;

interface Rendered {
  fetchMock: ReturnType<typeof vi.fn>;
  guard: { current: LeaveGuard | null };
}

async function renderScreen(onFetch: FetchHandler): Promise<Rendered> {
  const guard: Rendered["guard"] = { current: null };
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
    return Promise.resolve(onFetch(method, input, body));
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<RecipesScreen setLeaveGuard={(g) => (guard.current = g)} />);
  await vi.waitFor(() => {
    expect(
      screen.queryByTestId("recipe-table") !== null ||
        screen.queryByTestId("recipes-error") !== null,
    ).toBe(true);
  });
  return { fetchMock, guard };
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

function bodyOf(
  fetchMock: ReturnType<typeof vi.fn>,
  method: string,
  url: string,
  last = false,
): unknown {
  const matches = fetchMock.mock.calls.filter(
    ([urlArg, init]) =>
      urlArg === url && ((init as RequestInit | undefined)?.method ?? "GET") === method,
  );
  const call = last ? matches.at(-1) : matches[0];
  const init = call?.[1] as RequestInit | undefined;
  return typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
}

function fillForm(id: string, name: string): void {
  fireEvent.change(screen.getByTestId("field-id"), { target: { value: id } });
  fireEvent.change(screen.getByTestId("field-name"), { target: { value: name } });
}

function selectFile(testId: string, file: File): void {
  const input = screen.getByTestId(testId) as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file] });
  fireEvent.change(input);
}

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
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

describe("recipes screen", () => {
  it("lists recipe metadata and labels seeded examples as demonstrations", async () => {
    const { fetchMock } = await renderScreen((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, LISTING);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    expect(screen.getByTestId("label-email-triage").textContent).toBe(
      "Demonstration - not a production-validated policy",
    );
    expect(screen.getByTestId("label-my-recipe").textContent).toBe("Custom");
    expect(screen.getByTestId("recipe-my-recipe").textContent).toContain("typed-decisions");
    expect(screen.getByTestId("recipe-my-recipe").textContent).toContain("A test recipe");
    expect(callsTo(fetchMock, "GET", "/v1/recipes")).toBe(1);
  });

  it("shows a load error with a retry action", async () => {
    let fail = true;
    const { fetchMock } = await renderScreen((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        if (fail) {
          return jsonResponse(500, { code: "internal", message: "internal error" });
        }
        return jsonResponse(200, LISTING);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    expect(screen.getByTestId("recipes-error").textContent).toContain("internal error");
    fail = false;
    screen.getByTestId("recipes-retry").click();
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-table")).toBeTruthy());
    expect(callsTo(fetchMock, "GET", "/v1/recipes")).toBe(2);
  });

  it("authors all three primitives and saves the ordered payload through POST /v1/recipes", async () => {
    let created: unknown = null;
    const { fetchMock } = await renderScreen((method, url, body) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: [], invalid: [] });
      }
      if (method === "POST" && url === "/v1/recipes") {
        created = body;
        return jsonResponse(201, body);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    screen.getByTestId("new-recipe").click();
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-form")).toBeTruthy());
    fillForm("triage", "Triage");
    // Question 0: the default true/false question.
    fireEvent.change(screen.getByTestId("q-id-0"), { target: { value: "urgent" } });
    fireEvent.change(screen.getByTestId("q-instructions-0"), {
      target: { value: "Urgent?" },
    });
    // Question 1: a choice question with two options.
    screen.getByTestId("add-question").click();
    await vi.waitFor(() => expect(screen.queryByTestId("q-type-1")).toBeTruthy());
    fireEvent.change(screen.getByTestId("q-type-1"), { target: { value: "choice" } });
    fireEvent.change(screen.getByTestId("q-id-1"), { target: { value: "department" } });
    fireEvent.change(screen.getByTestId("q-instructions-1"), {
      target: { value: "Which department?" },
    });
    screen.getByTestId("add-option-1").click();
    await vi.waitFor(() => expect(screen.queryByTestId("option-key-1-0")).toBeTruthy());
    fireEvent.change(screen.getByTestId("option-key-1-0"), { target: { value: "sales" } });
    fireEvent.change(screen.getByTestId("option-description-1-0"), {
      target: { value: "Pricing" },
    });
    screen.getByTestId("add-option-1").click();
    await vi.waitFor(() => expect(screen.queryByTestId("option-key-1-1")).toBeTruthy());
    fireEvent.change(screen.getByTestId("option-key-1-1"), { target: { value: "finance" } });
    fireEvent.change(screen.getByTestId("option-description-1-1"), {
      target: { value: "Invoices" },
    });
    // Question 2: a score question with two levels.
    screen.getByTestId("add-question").click();
    await vi.waitFor(() => expect(screen.queryByTestId("q-type-2")).toBeTruthy());
    fireEvent.change(screen.getByTestId("q-type-2"), { target: { value: "score" } });
    fireEvent.change(screen.getByTestId("q-id-2"), { target: { value: "priority" } });
    fireEvent.change(screen.getByTestId("q-instructions-2"), {
      target: { value: "How important?" },
    });
    screen.getByTestId("add-level-2").click();
    await vi.waitFor(() => expect(screen.queryByTestId("level-input-2-0")).toBeTruthy());
    fireEvent.change(screen.getByTestId("level-input-2-0"), { target: { value: "low" } });
    screen.getByTestId("add-level-2").click();
    await vi.waitFor(() => expect(screen.queryByTestId("level-input-2-1")).toBeTruthy());
    fireEvent.change(screen.getByTestId("level-input-2-1"), { target: { value: "high" } });

    screen.getByTestId("save").click();
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-form")).toBeNull());
    expect(callsTo(fetchMock, "POST", "/v1/recipes")).toBe(1);
    const payload = created as Record<string, Record<string, unknown>>;
    expect(payload.schema_version).toBe(1);
    expect(payload.id).toBe("triage");
    expect(payload.name).toBe("Triage");
    expect(payload.model_profile).toBe("typed-decisions");
    expect(payload.review_policy).toEqual({
      default_min_confidence: 0.8,
      on_low_confidence: "needs_review",
    });
    // Question and option order is the form's order.
    expect(Object.keys(payload.questions)).toEqual(["urgent", "department", "priority"]);
    const department = payload.questions.department as Record<string, unknown>;
    expect(Object.keys(department.criteria as Record<string, unknown>)).toEqual([
      "sales",
      "finance",
    ]);
    const priority = payload.questions.priority as Record<string, unknown>;
    expect(priority.criteria).toEqual(["low", "high"]);
  });

  it("edits through PUT, preserving stable ids and the reordered questions/options", async () => {
    let replaced: unknown = null;
    const { fetchMock } = await renderScreen((method, url, body) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, LISTING);
      }
      if (method === "GET" && url === "/v1/recipes/my-recipe") {
        return jsonResponse(200, RECIPE);
      }
      if (method === "PUT" && url === "/v1/recipes/my-recipe") {
        replaced = body;
        return jsonResponse(200, body);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    screen.getByTestId("edit-my-recipe").click();
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-form")).toBeTruthy());
    const idField = screen.getByTestId("field-id") as HTMLInputElement;
    expect(idField.disabled).toBe(true);
    expect(idField.value).toBe("my-recipe");

    // Reorder the questions: [department, urgent] -> [urgent, department].
    screen.getByTestId("question-up-1").click();
    await vi.waitFor(() =>
      expect(screen.getByTestId("q-id-0").getAttribute("value")).toBe("urgent"),
    );
    // Reorder department's options: [sales, finance] -> [finance, sales].
    screen.getByTestId("option-down-1-0").click();
    await vi.waitFor(() =>
      expect(screen.getByTestId("option-key-1-0").getAttribute("value")).toBe("finance"),
    );
    // Remove the first question (urgent), keeping department.
    screen.getByTestId("question-remove-0").click();
    await vi.waitFor(() => expect(screen.queryByTestId("q-id-1")).toBeNull());

    screen.getByTestId("save").click();
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-form")).toBeNull());
    expect(callsTo(fetchMock, "PUT", "/v1/recipes/my-recipe")).toBe(1);
    expect(callsTo(fetchMock, "POST", "/v1/recipes")).toBe(0);
    const payload = replaced as Record<string, Record<string, unknown>>;
    const questions = payload.questions as Record<string, Record<string, unknown>>;
    // Only the remaining question, with its stable id and reordered options.
    expect(Object.keys(questions)).toEqual(["department"]);
    expect(Object.keys(questions.department.criteria as Record<string, unknown>)).toEqual([
      "finance",
      "sales",
    ]);
  });

  it("blocks invalid ids client-side, without any request", async () => {
    const { fetchMock } = await renderScreen((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: [], invalid: [] });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    screen.getByTestId("new-recipe").click();
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-form")).toBeTruthy());
    fireEvent.change(screen.getByTestId("field-id"), { target: { value: "Bad Id" } });
    fireEvent.change(screen.getByTestId("field-name"), { target: { value: "Name" } });
    fireEvent.change(screen.getByTestId("q-id-0"), { target: { value: "Urgent" } });
    fireEvent.change(screen.getByTestId("q-instructions-0"), {
      target: { value: "I?" },
    });
    // An invalid option key.
    fireEvent.change(screen.getByTestId("q-type-0"), { target: { value: "choice" } });
    screen.getByTestId("add-option-0").click();
    await vi.waitFor(() => expect(screen.queryByTestId("option-key-0-0")).toBeTruthy());
    fireEvent.change(screen.getByTestId("option-key-0-0"), { target: { value: "Sales!" } });
    fireEvent.change(screen.getByTestId("option-description-0-0"), {
      target: { value: "Pricing" },
    });
    screen.getByTestId("add-option-0").click();
    await vi.waitFor(() => expect(screen.queryByTestId("option-key-0-1")).toBeTruthy());
    fireEvent.change(screen.getByTestId("option-key-0-1"), { target: { value: "ok" } });
    fireEvent.change(screen.getByTestId("option-description-0-1"), {
      target: { value: "Fine" },
    });

    screen.getByTestId("save").click();
    await vi.waitFor(() => expect(screen.queryByTestId("issues-id")).toBeTruthy());
    expect(screen.getByTestId("issues-id").textContent).toContain("kebab-case");
    expect(screen.getByTestId("issues-question-0").textContent).toContain(
      "must start with a letter",
    );
    expect(screen.getByTestId("issues-question-0").textContent).toContain(
      "lowercase letters/digits",
    );
    // Still on the form, and nothing was sent.
    expect(screen.queryByTestId("recipe-form")).toBeTruthy();
    expect(callsTo(fetchMock, "POST", "/v1/recipes")).toBe(0);
  });

  it("surfaces server validation issues field-level", async () => {
    const { fetchMock } = await renderScreen((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: [], invalid: [] });
      }
      if (method === "POST" && url === "/v1/recipes") {
        return jsonResponse(422, {
          code: "invalid_recipe",
          message: "recipe is invalid",
          request_id: "rid-1",
          issues: [
            {
              location: "questions.urgent.criteria.sales",
              message: "URLs are not allowed",
            },
            {
              location: "review_policy.default_min_confidence",
              message: "must be less than or equal to 1",
            },
          ],
        });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    screen.getByTestId("new-recipe").click();
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-form")).toBeTruthy());
    fillForm("my-recipe", "Mine");
    fireEvent.change(screen.getByTestId("q-id-0"), { target: { value: "urgent" } });
    fireEvent.change(screen.getByTestId("q-instructions-0"), {
      target: { value: "Urgent?" },
    });
    // The form passes the client-side rules; the service is authoritative
    // and rejects it with field-level issues.
    screen.getByTestId("save").click();
    await vi.waitFor(() => expect(screen.queryByTestId("issues-threshold")).toBeTruthy());
    expect(screen.getByTestId("issues-threshold").textContent).toContain(
      "must be less than or equal to 1",
    );
    expect(screen.getByTestId("issues-question-0").textContent).toContain(
      "URLs are not allowed",
    );
    expect(screen.getByTestId("server-error").textContent).toContain("recipe is invalid");
    // One request, no implicit retry.
    expect(callsTo(fetchMock, "POST", "/v1/recipes")).toBe(1);
    // Still on the form.
    expect(screen.queryByTestId("recipe-form")).toBeTruthy();
  });

  it("reports a duplicate id (409) without saving", async () => {
    const { fetchMock } = await renderScreen((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: [], invalid: [] });
      }
      if (method === "POST" && url === "/v1/recipes") {
        return jsonResponse(409, {
          code: "recipe_exists",
          message: "a recipe with that id already exists",
        });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    screen.getByTestId("new-recipe").click();
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-form")).toBeTruthy());
    fillForm("my-recipe", "Mine");
    fireEvent.change(screen.getByTestId("q-id-0"), { target: { value: "urgent" } });
    fireEvent.change(screen.getByTestId("q-instructions-0"), {
      target: { value: "Urgent?" },
    });
    screen.getByTestId("save").click();
    await vi.waitFor(() => expect(screen.queryByTestId("server-error")).toBeTruthy());
    expect(screen.getByTestId("server-error").textContent).toContain(
      "a recipe with that id already exists",
    );
    expect(screen.queryByTestId("recipe-form")).toBeTruthy();
    expect(callsTo(fetchMock, "POST", "/v1/recipes")).toBe(1);
  });

  it("duplicates to a new id through POST, never PUT, and refuses the original id", async () => {
    const { fetchMock } = await renderScreen((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, LISTING);
      }
      if (method === "GET" && url === "/v1/recipes/my-recipe") {
        return jsonResponse(200, RECIPE);
      }
      if (method === "POST" && url === "/v1/recipes") {
        return jsonResponse(201, {});
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    screen.getByTestId("duplicate-my-recipe").click();
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-form")).toBeTruthy());
    expect(screen.getByTestId("form-mode").textContent).toContain("Duplicate of my-recipe");
    expect(screen.getByTestId("field-id").getAttribute("value")).toBe("my-recipe-copy");

    // Keeping the original id is refused client-side.
    fireEvent.change(screen.getByTestId("field-id"), { target: { value: "my-recipe" } });
    screen.getByTestId("save").click();
    await vi.waitFor(() => expect(screen.queryByTestId("issues-id")).toBeTruthy());
    expect(screen.getByTestId("issues-id").textContent).toContain("different from the original");
    expect(callsTo(fetchMock, "POST", "/v1/recipes")).toBe(0);

    // A new id goes through POST.
    fireEvent.change(screen.getByTestId("field-id"), {
      target: { value: "my-recipe-copy" },
    });
    fireEvent.change(screen.getByTestId("field-name"), { target: { value: "Copied" } });
    screen.getByTestId("save").click();
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-form")).toBeNull());
    expect(callsTo(fetchMock, "POST", "/v1/recipes")).toBe(1);
    expect(callsTo(fetchMock, "PUT", "/v1/recipes/my-recipe")).toBe(0);
    const payload = bodyOf(fetchMock, "POST", "/v1/recipes") as Record<string, unknown>;
    expect(payload.id).toBe("my-recipe-copy");
  });

  it("validates without saving and shows the report", async () => {
    let validated: unknown = null;
    const { fetchMock } = await renderScreen((method, url, body) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, LISTING);
      }
      if (method === "GET" && url === "/v1/recipes/my-recipe") {
        return jsonResponse(200, RECIPE);
      }
      if (method === "POST" && url === "/v1/recipes/validate") {
        validated = body;
        return jsonResponse(200, {
          valid: true,
          issues: [],
          warnings: [
            {
              code: "score_weak",
              message:
                "Ordinal score questions are currently less reliable than choice and true/false questions.",
              question_id: "department",
            },
          ],
          recipe: null,
        });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    screen.getByTestId("edit-my-recipe").click();
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-form")).toBeTruthy());
    screen.getByTestId("validate").click();
    await vi.waitFor(() => expect(screen.queryByTestId("validate-report")).toBeTruthy());
    expect(callsTo(fetchMock, "POST", "/v1/recipes/validate")).toBe(1);
    const body = validated as { recipe: Record<string, unknown> };
    expect(body.recipe.id).toBe("my-recipe");
    expect(screen.getByTestId("report-valid").textContent).toContain("Valid");
    expect(screen.getByTestId("report-valid").textContent).toContain("nothing was saved");
    expect(screen.getByTestId("report-warnings").textContent).toContain("score_weak");
    expect(screen.getByTestId("report-warnings").textContent).toContain("less reliable");
    // No create or replace was issued.
    expect(callsTo(fetchMock, "POST", "/v1/recipes")).toBe(0);
    expect(callsTo(fetchMock, "PUT", "/v1/recipes/my-recipe")).toBe(0);
    // Still on the form.
    expect(screen.queryByTestId("recipe-form")).toBeTruthy();
  });

  it("imports a user-selected YAML file as bounded text, never the file name or path", async () => {
    const yamlText = "schema_version: 1\nid: imported-recipe\nname: Imported\nquestions:\n  q:\n    type: noul\n    instructions: Q?\n";
    let imported: unknown = null;
    let importedDone = false;
    const { fetchMock } = await renderScreen((method, url, body) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, {
          recipes: importedDone
            ? [
                ...LISTING.recipes,
                {
                  id: "imported-recipe",
                  name: "Imported",
                  description: "",
                  model_profile: "typed-decisions",
                  question_count: 1,
                  example: false,
                },
              ]
            : LISTING.recipes,
          invalid: [],
        });
      }
      if (method === "POST" && url === "/v1/recipes/import") {
        imported = body;
        importedDone = true;
        return jsonResponse(201, { id: "imported-recipe" });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const file = new File([yamlText], "my-import.yaml", { type: "text/yaml" });
    selectFile("import-file", file);
    // The listing only gains the imported recipe after the import call, so
    // this wait also lets the (async file read + request) flow complete.
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-imported-recipe")).toBeTruthy());
    expect(callsTo(fetchMock, "POST", "/v1/recipes/import")).toBe(1);
    const body = imported as { yaml: string; overwrite: boolean };
    expect(body.yaml).toBe(yamlText);
    expect(body.overwrite).toBe(false);
    // The file name and path never reach the service.
    expect(JSON.stringify(imported)).not.toContain("my-import.yaml");
  });

  it("rejects an oversized file before reading it and sends no request", async () => {
    const { fetchMock } = await renderScreen((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: [], invalid: [] });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    // 65537 bytes: one over the 64 KiB bound. The file's byte size alone
    // trips the pre-read check, so the content is never read or sent.
    const file = new File([new Uint8Array(65537)], "too-big.yaml", { type: "text/yaml" });
    selectFile("import-file", file);
    await vi.waitFor(() => expect(screen.queryByTestId("import-error")).toBeTruthy());
    expect(screen.getByTestId("import-error").textContent).toContain("larger than 64 KiB");
    expect(callsTo(fetchMock, "POST", "/v1/recipes/import")).toBe(0);
  });

  it("rejects a multibyte file by its UTF-8 byte length, not its string length", async () => {
    const { fetchMock } = await renderScreen((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: [], invalid: [] });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    // 40000 two-byte characters: 40000 UTF-16 units (under 64 KiB, so the
    // old string-length check would have accepted it) but 80000 UTF-8 bytes
    // (over the bound). The import must be rejected and nothing sent.
    const content = "é".repeat(40000);
    const file = new File([content], "multibyte.yaml", { type: "text/yaml" });
    expect(file.size).toBe(80000);
    selectFile("import-file", file);
    await vi.waitFor(() => expect(screen.queryByTestId("import-error")).toBeTruthy());
    expect(screen.getByTestId("import-error").textContent).toContain("larger than 64 KiB");
    expect(callsTo(fetchMock, "POST", "/v1/recipes/import")).toBe(0);
  });

  it("reports a file read failure and sends no request", async () => {
    const { fetchMock } = await renderScreen((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: [], invalid: [] });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const file = new File(["schema_version: 1\n"], "unreadable.yaml", { type: "text/yaml" });
    Object.defineProperty(file, "text", {
      value: () => Promise.reject(new Error("read failed")),
    });
    selectFile("import-file", file);
    await vi.waitFor(() => expect(screen.queryByTestId("import-error")).toBeTruthy());
    expect(screen.getByTestId("import-error").textContent).toContain("could not read");
    expect(callsTo(fetchMock, "POST", "/v1/recipes/import")).toBe(0);
  });

  it("offers an explicit overwrite when an import conflicts", async () => {
    const yamlText = "schema_version: 1\nid: my-recipe\nname: Again\nquestions:\n  q:\n    type: noul\n    instructions: Q?\n";
    let overwriteCalls = 0;
    const { fetchMock } = await renderScreen((method, url, body) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, LISTING);
      }
      if (method === "POST" && url === "/v1/recipes/import") {
        const request = body as { yaml: string; overwrite: boolean };
        if (request.overwrite) {
          overwriteCalls += 1;
          return jsonResponse(201, { id: "my-recipe" });
        }
        return jsonResponse(409, {
          code: "recipe_exists",
          message: "a recipe with that id already exists",
        });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const file = new File([yamlText], "conflict.yaml", { type: "text/yaml" });
    selectFile("import-file", file);
    await vi.waitFor(() => expect(screen.queryByTestId("import-conflict")).toBeTruthy());
    expect(callsTo(fetchMock, "POST", "/v1/recipes/import")).toBe(1);
    screen.getByTestId("import-overwrite").click();
    await vi.waitFor(() => expect(screen.queryByTestId("import-conflict")).toBeNull());
    expect(callsTo(fetchMock, "POST", "/v1/recipes/import")).toBe(2);
    expect(overwriteCalls).toBe(1);
    expect(
      (bodyOf(fetchMock, "POST", "/v1/recipes/import", true) as {
        overwrite: boolean;
      }).overwrite,
    ).toBe(true);
  });

  it("exports the recipe as the API's YAML text", async () => {
    const yamlText = "id: my-recipe\nname: Mine\n";
    const { fetchMock } = await renderScreen((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, LISTING);
      }
      if (method === "GET" && url === "/v1/recipes/my-recipe/export") {
        return jsonResponse(200, yamlText);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const createObjectURL = vi.fn((_blob: Blob) => "blob:openreflex-test");
    const revokeObjectURL = vi.fn((_url: string) => undefined);
    vi.stubGlobal(
      "URL",
      Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }),
    );
    const appendSpy = vi.spyOn(document.body, "appendChild");
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    screen.getByTestId("export-my-recipe").click();
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(callsTo(fetchMock, "GET", "/v1/recipes/my-recipe/export")).toBe(1);
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(await blobText(blob as Blob)).toBe(yamlText);
    const anchor = appendSpy.mock.calls.at(-1)?.[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("my-recipe.yaml");
    expect(revokeObjectURL).toHaveBeenCalled();
  });

  it("deletes only after typing the exact id, sending the API confirmation", async () => {
    let deleted = false;
    const { fetchMock } = await renderScreen((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        if (deleted) {
          return jsonResponse(200, {
            recipes: [LISTING.recipes[0]],
            invalid: [],
          });
        }
        return jsonResponse(200, LISTING);
      }
      if (method === "DELETE" && url === "/v1/recipes/my-recipe?confirm=my-recipe") {
        deleted = true;
        return jsonResponse(204, "");
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    screen.getByTestId("delete-my-recipe").click();
    await vi.waitFor(() => expect(screen.queryByTestId("delete-dialog")).toBeTruthy());
    // The confirm button is disabled until the exact id is typed.
    const confirm = () => screen.getByTestId("delete-confirm") as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);
    fireEvent.change(screen.getByTestId("delete-confirm-input"), {
      target: { value: "wrong" },
    });
    expect(confirm().disabled).toBe(true);
    fireEvent.change(screen.getByTestId("delete-confirm-input"), {
      target: { value: "my-recipe" },
    });
    expect(confirm().disabled).toBe(false);
    screen.getByTestId("delete-confirm").click();
    await vi.waitFor(() => expect(screen.queryByTestId("delete-dialog")).toBeNull());
    expect(callsTo(fetchMock, "DELETE", "/v1/recipes/my-recipe?confirm=my-recipe")).toBe(1);
    // The list refreshed without the deleted recipe.
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-my-recipe")).toBeNull());
    expect(screen.queryByTestId("recipe-email-triage")).toBeTruthy();
  });

  it("prevents double submission and warns before discarding unsaved edits", async () => {
    let resolveCreate: (response: Response) => void = () => undefined;
    const { fetchMock, guard } = await renderScreen((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: [], invalid: [] });
      }
      if (method === "POST" && url === "/v1/recipes") {
        return new Promise<Response>((resolve) => {
          resolveCreate = resolve;
        });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    screen.getByTestId("new-recipe").click();
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-form")).toBeTruthy());
    fillForm("dup-test", "Dup");
    fireEvent.change(screen.getByTestId("q-id-0"), { target: { value: "urgent" } });
    fireEvent.change(screen.getByTestId("q-instructions-0"), {
      target: { value: "Urgent?" },
    });

    // Double submission: the save is in flight, the button is disabled, and a
    // second click issues no second request.
    screen.getByTestId("save").click();
    await vi.waitFor(
      () =>
        expect((screen.getByTestId("save") as HTMLButtonElement).disabled).toBe(true),
    );
    fireEvent.click(screen.getByTestId("save"));
    expect(callsTo(fetchMock, "POST", "/v1/recipes")).toBe(1);
    resolveCreate(jsonResponse(201, {}));
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-form")).toBeNull());
    expect(callsTo(fetchMock, "POST", "/v1/recipes")).toBe(1);

    // Unsaved edits: the leave guard blocks navigation and offers a choice.
    screen.getByTestId("new-recipe").click();
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-form")).toBeTruthy());
    fireEvent.change(screen.getByTestId("field-id"), { target: { value: "unsaved" } });
    expect(guard.current).not.toBeNull();
    expect(guard.current?.("setup")).toBe(true);
    await vi.waitFor(() => expect(screen.queryByTestId("discard-dialog")).toBeTruthy());
    // Stay: the form is kept.
    screen.getByTestId("discard-stay").click();
    await vi.waitFor(() => expect(screen.queryByTestId("discard-dialog")).toBeNull());
    expect(screen.queryByTestId("recipe-form")).toBeTruthy();
    // Leave: the hash changes and the form is gone.
    expect(guard.current?.("setup")).toBe(true);
    await vi.waitFor(() => expect(screen.queryByTestId("discard-dialog")).toBeTruthy());
    screen.getByTestId("discard-go").click();
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-form")).toBeNull());
    expect(window.location.hash).toBe("#/setup");
  });

  it("rejects duplicate question ids client-side and sends no request", async () => {
    const { fetchMock } = await renderScreen((method, url) => {
      if (method === "GET" && url === "/v1/recipes") {
        return jsonResponse(200, { recipes: [], invalid: [] });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    screen.getByTestId("new-recipe").click();
    await vi.waitFor(() => expect(screen.queryByTestId("recipe-form")).toBeTruthy());
    fillForm("dup-ids", "DupIds");
    fireEvent.change(screen.getByTestId("q-id-0"), { target: { value: "urgent" } });
    fireEvent.change(screen.getByTestId("q-instructions-0"), {
      target: { value: "Urgent?" },
    });
    screen.getByTestId("add-question").click();
    await vi.waitFor(() => expect(screen.queryByTestId("q-id-1")).toBeTruthy());
    fireEvent.change(screen.getByTestId("q-id-1"), { target: { value: "urgent" } });
    fireEvent.change(screen.getByTestId("q-instructions-1"), {
      target: { value: "Urgent again" },
    });

    // The duplicate id is rejected before any payload is built.
    screen.getByTestId("save").click();
    await vi.waitFor(() => expect(screen.queryByTestId("issues-question-0")).toBeTruthy());
    expect(screen.getByTestId("issues-question-0").textContent).toContain(
      "question ids must be unique",
    );
    // No create or replace request was issued, and the form is kept so the
    // user can fix the duplicate (the second question is not silently dropped).
    expect(callsTo(fetchMock, "POST", "/v1/recipes")).toBe(0);
    expect(callsTo(fetchMock, "PUT", "/v1/recipes/dup-ids")).toBe(0);
    expect(screen.queryByTestId("recipe-form")).toBeTruthy();
  });
});
