/**
 * Client-side model of the schema-version-1 recipe contract and of the
 * recipe form.
 *
 * The form is the single source of truth for every payload this app sends:
 * only the schema-version-1 fields exist in the form, so an unknown or
 * invalid field cannot be silently discarded and saved as if it were valid.
 * Client-side validation mirrors the service's rules (same limits, same id
 * patterns, same inert-text checks) so problems are surfaced before
 * submission; the service remains authoritative, and its issues use the
 * same ``location`` scheme and are displayed field-level as well.
 *
 * Question and option order is significant: the payload's object key order
 * carries it, and editing preserves the existing ids and keys in place.
 */

import type { ModelProfile } from "./types";

// -- wire types (mirror the service's Pydantic models) -------------------------

export interface Issue {
  readonly location: string;
  readonly message: string;
}

export interface Warning {
  readonly code: string;
  readonly message: string;
  readonly question_id: string | null;
}

export interface RecipeSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly model_profile: ModelProfile;
  readonly question_count: number;
  readonly example: boolean;
}

export interface InvalidRecipeFile {
  readonly id: string;
  readonly issues: readonly Issue[];
}

export interface RecipeListing {
  readonly recipes: readonly RecipeSummary[];
  readonly invalid: readonly InvalidRecipeFile[];
}

export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly min_confidence: number | null;
  readonly criteria: Record<string, string>;
}

export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  readonly min_confidence: number | null;
  readonly criteria: readonly string[];
}

export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly min_confidence: number | null;
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface ReviewPolicy {
  readonly default_min_confidence: number;
  readonly on_low_confidence: "needs_review";
}

export interface Recipe {
  readonly schema_version: 1;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly model_profile: ModelProfile;
  readonly questions: Record<string, Question>;
  readonly review_policy: ReviewPolicy;
}

export interface ValidationReport {
  readonly valid: boolean;
  readonly issues: readonly Issue[];
  readonly warnings: readonly Warning[];
  readonly recipe: Recipe | null;
}

// -- limits and patterns (mirror the service) ----------------------------------

export const LIMITS = {
  recipeId: 64,
  questionId: 64,
  optionKey: 64,
  name: 100,
  description: 500,
  instructions: 1000,
  criterion: 300,
  maxQuestions: 20,
  choiceMinOptions: 2,
  choiceMaxOptions: 50,
  choiceRecommendedMaxOptions: 20,
  scoreMinLevels: 2,
  scoreMaxLevels: 10,
  yamlBytes: 64 * 1024,
} as const;

export const RECIPE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const QUESTION_ID_RE = /^[a-z][a-z0-9_]*$/;
export const OPTION_KEY_RE = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

const THRESHOLD_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

// Recipes are inert data. Text that looks like it might be expanded,
// templated, fetched, or opened is rejected, mirroring the service's rules.
// The ASCII control/format character set the service rejects, built with
// String.fromCharCode so this source file stays plain text.
const CONTROL_CHARS_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
);

const FORBIDDEN_TEXT: readonly (readonly [RegExp, string])[] = [
  [/\{\{|\{%|\$\{|<%/u, "template or expansion syntax is not allowed"],
  [/%[A-Za-z_][A-Za-z0-9_]*%/u, "environment-variable syntax is not allowed"],
  [/[a-z][a-z0-9+.-]*:\/\//iu, "URLs are not allowed"],
  [CONTROL_CHARS_RE, "control characters are not allowed"],
];

/** The first inert-text violation in ``value``, or ``null`` when clean. */
export function checkInertText(value: string): string | null {
  for (const [pattern, message] of FORBIDDEN_TEXT) {
    if (pattern.test(value)) {
      return message;
    }
  }
  return null;
}

function parseThreshold(value: string): number | null {
  const trimmed = value.trim();
  if (!THRESHOLD_RE.test(trimmed)) {
    return null;
  }
  const number = Number(trimmed);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

// -- form state ------------------------------------------------------------------

export interface ChoiceOptionForm {
  key: string;
  description: string;
}

export interface QuestionForm {
  id: string;
  type: "choice" | "score" | "noul";
  instructions: string;
  /** Raw input text; the empty string means "inherit the recipe default". */
  minConfidence: string;
  /** ``choice`` options, in display order. */
  options: ChoiceOptionForm[];
  /** ``score`` levels, lowest first. */
  levels: string[];
}

export interface RecipeForm {
  id: string;
  name: string;
  description: string;
  modelProfile: ModelProfile;
  /** Raw input text for the review-policy default threshold. */
  defaultMinConfidence: string;
  questions: QuestionForm[];
}

/** A fresh form: one empty true/false question, the service's default policy. */
export function newRecipeForm(): RecipeForm {
  return {
    id: "",
    name: "",
    description: "",
    modelProfile: "typed-decisions",
    defaultMinConfidence: "0.8",
    questions: [
      { id: "", type: "noul", instructions: "", minConfidence: "", options: [], levels: [] },
    ],
  };
}

function questionFromWire(question: Question): Omit<QuestionForm, "id"> {
  const base: Omit<QuestionForm, "id"> = {
    type: question.type,
    instructions: question.instructions,
    minConfidence: question.min_confidence === null ? "" : String(question.min_confidence),
    options: [],
    levels: [],
  };
  if (question.type === "choice") {
    base.options = Object.entries(question.criteria).map(([key, description]) => ({
      key,
      description,
    }));
  } else if (question.type === "score") {
    base.levels = [...question.criteria];
  }
  return base;
}

/**
 * Load a recipe from the service into the form, preserving the question
 * order (the service's key order) and the option/level order.
 */
export function formFromRecipe(recipe: Recipe): RecipeForm {
  return {
    id: recipe.id,
    name: recipe.name,
    description: recipe.description,
    modelProfile: recipe.model_profile,
    defaultMinConfidence: String(recipe.review_policy.default_min_confidence),
    questions: Object.entries(recipe.questions).map(([id, question]) => ({
      ...questionFromWire(question),
      id,
    })),
  };
}

function questionToPayload(question: QuestionForm): Record<string, unknown> {
  const minConfidence =
    question.minConfidence.trim() === "" ? null : parseThreshold(question.minConfidence);
  if (question.type === "choice") {
    const criteria: Record<string, string> = {};
    for (const option of question.options) {
      criteria[option.key] = option.description;
    }
    return {
      type: "choice",
      instructions: question.instructions,
      min_confidence: minConfidence,
      criteria,
    };
  }
  if (question.type === "score") {
    return {
      type: "score",
      instructions: question.instructions,
      min_confidence: minConfidence,
      criteria: question.levels,
    };
  }
  return {
    type: "noul",
    instructions: question.instructions,
    min_confidence: minConfidence,
  };
}

/**
 * Build the exact JSON body for the service: only the schema-version-1
 * fields, in the form's order. Nothing else can get in, so an unknown
 * field cannot be silently saved. A duplicate question id would make the
 * later question overwrite the earlier one in the payload; instead the
 * build refuses, so no question can be silently discarded.
 */
export function toPayload(form: RecipeForm): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const question of form.questions) {
    if (seen.has(question.id)) {
      throw new Error(`duplicate question id: ${question.id}`);
    }
    seen.add(question.id);
    questions[question.id] = questionToPayload(question);
  }
  return {
    schema_version: 1,
    id: form.id,
    name: form.name,
    description: form.description,
    model_profile: form.modelProfile,
    questions,
    review_policy: {
      default_min_confidence: parseThreshold(form.defaultMinConfidence) ?? 0.8,
      on_low_confidence: "needs_review",
    },
  };
}

// -- client-side validation -------------------------------------------------------

export interface FormIssue {
  readonly location: string;
  readonly message: string;
}

export interface FormValidation {
  readonly issues: FormIssue[];
  readonly warnings: string[];
}

function checkText(
  value: string,
  location: string,
  min: number,
  max: number,
  issues: FormIssue[],
): void {
  if (value.length < min) {
    issues.push({
      location,
      message: `must have at least ${min} character${min === 1 ? "" : "s"}`,
    });
    return;
  }
  if (value.length > max) {
    issues.push({ location, message: `must be at most ${max} characters` });
    return;
  }
  const violation = checkInertText(value);
  if (violation !== null) {
    issues.push({ location, message: violation });
  }
}

/**
 * Validate the form against the service's schema-version-1 rules. The
 * locations match the service's issue locations, so client and server
 * issues attach to the same fields.
 *
 * ``reservedId`` (duplicate mode): the id the new recipe must differ from.
 */
export function validateForm(
  form: RecipeForm,
  reservedId: string | null = null,
): FormValidation {
  const issues: FormIssue[] = [];
  const warnings: string[] = [];

  if (form.id.length === 0) {
    issues.push({ location: "id", message: "is required" });
  } else if (form.id.length > LIMITS.recipeId) {
    issues.push({ location: "id", message: `must be at most ${LIMITS.recipeId} characters` });
  } else if (!RECIPE_ID_RE.test(form.id)) {
    issues.push({
      location: "id",
      message: "must be lowercase kebab-case (letters, digits, and single dashes)",
    });
  } else if (reservedId !== null && form.id === reservedId) {
    issues.push({ location: "id", message: "must be a new id, different from the original" });
  }

  checkText(form.name, "name", 1, LIMITS.name, issues);
  checkText(form.description, "description", 0, LIMITS.description, issues);

  if (parseThreshold(form.defaultMinConfidence) === null) {
    issues.push({
      location: "review_policy.default_min_confidence",
      message: "must be a number between 0 and 1",
    });
  }

  if (form.questions.length === 0) {
    issues.push({ location: "questions", message: "a recipe needs at least one question" });
  } else if (form.questions.length > LIMITS.maxQuestions) {
    issues.push({
      location: "questions",
      message: `a recipe allows at most ${LIMITS.maxQuestions} questions`,
    });
  }

  const seenQuestionIds = new Set<string>();
  for (const [index, question] of form.questions.entries()) {
    const base = `questions.${question.id || `question-${index + 1}`}`;
    if (question.id.length === 0) {
      issues.push({ location: base, message: "the question id is required" });
    } else if (question.id.length > LIMITS.questionId) {
      issues.push({ location: base, message: `must be at most ${LIMITS.questionId} characters` });
    } else if (!QUESTION_ID_RE.test(question.id)) {
      issues.push({
        location: base,
        message: "must start with a letter, then letters, digits, or underscores",
      });
    }
    if (question.id.length > 0) {
      if (seenQuestionIds.has(question.id)) {
        issues.push({ location: base, message: "question ids must be unique" });
      }
      seenQuestionIds.add(question.id);
    }
    checkText(question.instructions, `${base}.instructions`, 1, LIMITS.instructions, issues);
    if (question.minConfidence.trim() !== "" && parseThreshold(question.minConfidence) === null) {
      issues.push({
        location: `${base}.min_confidence`,
        message: "must be a number between 0 and 1",
      });
    }

    if (question.type === "choice") {
      const n = question.options.length;
      if (n < LIMITS.choiceMinOptions) {
        issues.push({
          location: `${base}.criteria`,
          message: `a choice question needs at least ${LIMITS.choiceMinOptions} options`,
        });
      } else if (n > LIMITS.choiceMaxOptions) {
        issues.push({
          location: `${base}.criteria`,
          message: `a choice question allows at most ${LIMITS.choiceMaxOptions} options`,
        });
      }
      const seen = new Set<string>();
      for (const [i, option] of question.options.entries()) {
        const opt = `${base}.criteria.${option.key || `option-${i + 1}`}`;
        if (option.key.length === 0) {
          issues.push({ location: opt, message: "the option key is required" });
        } else if (option.key.length > LIMITS.optionKey) {
          issues.push({ location: opt, message: `must be at most ${LIMITS.optionKey} characters` });
        } else if (!OPTION_KEY_RE.test(option.key)) {
          issues.push({
            location: opt,
            message:
              "must be lowercase letters/digits separated by single dashes or underscores",
          });
        } else if (seen.has(option.key)) {
          issues.push({ location: opt, message: "option keys must be unique" });
        } else {
          seen.add(option.key);
        }
        checkText(option.description, opt, 1, LIMITS.criterion, issues);
      }
      if (n > LIMITS.choiceRecommendedMaxOptions) {
        warnings.push(
          `${n} options is above the recommended ${LIMITS.choiceRecommendedMaxOptions}; accuracy can drop sharply.`,
        );
      }
    } else if (question.type === "score") {
      const n = question.levels.length;
      if (n < LIMITS.scoreMinLevels) {
        issues.push({
          location: `${base}.criteria`,
          message: `a score question needs at least ${LIMITS.scoreMinLevels} levels`,
        });
      } else if (n > LIMITS.scoreMaxLevels) {
        issues.push({
          location: `${base}.criteria`,
          message: `a score question allows at most ${LIMITS.scoreMaxLevels} levels`,
        });
      }
      const seen = new Set<string>();
      for (const [i, level] of question.levels.entries()) {
        const loc = `${base}.criteria.${i}`;
        if (seen.has(level)) {
          issues.push({ location: loc, message: "score levels must be distinct" });
        } else {
          seen.add(level);
        }
        checkText(level, loc, 1, LIMITS.criterion, issues);
      }
      warnings.push(
        "Ordinal score questions are currently less reliable than choice and true/false questions.",
      );
    }
  }

  return { issues, warnings };
}

// -- issue-to-field mapping ---------------------------------------------------------

export const TOP_LEVEL_FIELDS = [
  "id",
  "name",
  "description",
  "model_profile",
  "review_policy.default_min_confidence",
  "review_policy.on_low_confidence",
] as const;

export type TopLevelField = (typeof TOP_LEVEL_FIELDS)[number];

export interface GroupedIssues {
  /** Issues attached to top-level fields, keyed by location. */
  readonly top: Partial<Record<TopLevelField, (Issue | FormIssue)[]>>;
  /** Issues attached to each question, in form order. */
  readonly questions: (Issue | FormIssue)[][];
  /** Issues that do not map to a known field. */
  readonly general: (Issue | FormIssue)[];
}

/**
 * Group client and server issues by the form field each one belongs to.
 *
 * A question's issues are matched by its id; when the id is empty (or a
 * server issue names an id the form no longer has), the client-side
 * placeholder ``question-<n>`` keeps the mapping positional, so issues for
 * the same field line up on both sides.
 */
export function groupIssues(
  issues: readonly (Issue | FormIssue)[],
  form: RecipeForm,
): GroupedIssues {
  const top: Partial<Record<TopLevelField, (Issue | FormIssue)[]>> = {};
  const questions: (Issue | FormIssue)[][] = form.questions.map(() => []);
  const general: (Issue | FormIssue)[] = [];

  for (const issue of issues) {
    const location = issue.location;
    if ((TOP_LEVEL_FIELDS as readonly string[]).includes(location)) {
      const bucket = top[location as TopLevelField];
      if (bucket === undefined) {
        top[location as TopLevelField] = [issue];
      } else {
        bucket.push(issue);
      }
      continue;
    }
    const match = /^questions\.(.+)$/.exec(location);
    if (match !== null) {
      const [qid] = match[1].split(".");
      let index = form.questions.findIndex((q) => q.id === qid);
      if (index === -1) {
        const placeholder = /^question-(\d+)$/.exec(qid);
        if (placeholder !== null) {
          index = Number(placeholder[1]) - 1;
        }
      }
      if (index >= 0 && index < questions.length) {
        // Every issue under the question's prefix belongs to that question.
        questions[index].push(issue);
        continue;
      }
    }
    general.push(issue);
  }
  return { top, questions, general };
}
