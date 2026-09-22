/**
 * Client-side validation of decision input and pre-run warnings.
 *
 * The validation mirrors the service's documented input bounds (non-empty,
 * a JSON object, bounded depth/field count/serialized size, finite
 * numbers) so obvious problems are surfaced before a request is sent; the
 * service remains authoritative. Nothing here interprets input text:
 * strings that look like paths or URLs are inert content, and no check
 * opens, resolves, uploads, or fetches them.
 *
 * Preflight warnings compare the selected recipe and the input against
 * documented limits and known recipe limitations. They are usability
 * hints only: they never predict the model's answers and make no
 * accuracy claim.
 */

import type { Recipe } from "./recipeModel";

export const DECISION_INPUT_LIMITS = {
  /** The service's serialized-size bound (UTF-8 bytes). */
  maxSerializedBytes: 128 * 1024,
  /** The service's nesting bound (the root object is depth 1). */
  maxDepth: 8,
  /** The service's total object-value/array-item bound. */
  maxFields: 500,
} as const;

/** Above this share of a limit, a preflight warning is shown. */
export const NEAR_LIMIT_SHARE = 0.9;

/** The recommended maximum choice options (the recipe validation's). */
export const CHOICE_RECOMMENDED_MAX_OPTIONS = 20;

export type InputMode = "text" | "json";

export interface InputIssue {
  readonly location: string;
  readonly message: string;
}

export interface InputStats {
  /** Serialized UTF-8 byte length, or ``null`` when unmeasurable. */
  readonly sizeBytes: number | null;
  /** Total object values + array items, or ``null`` when unmeasurable. */
  readonly fieldCount: number | null;
  /** Maximum nesting depth (root = 1), or ``null`` when unmeasurable. */
  readonly depth: number | null;
}

export interface InputAnalysis {
  readonly issues: readonly InputIssue[];
  readonly stats: InputStats;
}

export interface PreflightWarning {
  readonly code: string;
  readonly message: string;
}

// -- measurement (mirrors the service's normalize_input) ----------------------

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Escape a string exactly like Python's ``json.dumps(ensure_ascii=False)``:
 * the short escapes for common control characters, ``\uXXXX`` for the rest
 * below 0x20, and every other character (including non-ASCII) verbatim.
 */
function escapeJsonString(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ch === '"') {
      out += '\\"';
    } else if (ch === "\\") {
      out += "\\\\";
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else if (ch === "\b") {
      out += "\\b";
    } else if (ch === "\f") {
      out += "\\f";
    } else {
      const code = ch.codePointAt(0) as number;
      if (code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, "0")}`;
      } else {
        out += ch;
      }
    }
  }
  return out;
}

/**
 * Serialize a value the way the service serializes it
 * (``json.dumps(state, ensure_ascii=False)`` with the default ``", "`` /
 * ``": "`` separators), so the measured UTF-8 byte length matches the
 * service's bound. Key order is preserved, as on both sides.
 */
function serializeLikeService(value: unknown): string {
  const render = (node: unknown): string => {
    if (node === null) {
      return "null";
    }
    if (typeof node === "boolean") {
      return node ? "true" : "false";
    }
    if (typeof node === "number") {
      return String(node);
    }
    if (typeof node === "string") {
      return `"${escapeJsonString(node)}"`;
    }
    if (Array.isArray(node)) {
      return `[${node.map(render).join(", ")}]`;
    }
    if (typeof node === "object") {
      const entries = Object.entries(node as Record<string, unknown>).map(
        ([key, child]) => `"${escapeJsonString(key)}": ${render(child)}`,
      );
      return `{${entries.join(", ")}}`;
    }
    return "null";
  };
  return render(value);
}

interface MeasureResult {
  readonly fields: number;
  readonly depth: number;
  readonly tooDeep: boolean;
  readonly tooManyFields: boolean;
  readonly nonFinite: boolean;
}

/**
 * Count fields and depth exactly like the service's ``_measure``: the root
 * is depth 1, and every object value and array item is one field.
 */
function measureInput(value: unknown): MeasureResult {
  let fields = 0;
  let depth = 0;
  let tooDeep = false;
  let tooManyFields = false;
  let nonFinite = false;
  const walk = (node: unknown, nodeDepth: number): void => {
    if (nodeDepth > DECISION_INPUT_LIMITS.maxDepth) {
      tooDeep = true;
      return;
    }
    depth = Math.max(depth, nodeDepth);
    if (typeof node !== "object" || node === null) {
      if (typeof node === "number" && !Number.isFinite(node)) {
        nonFinite = true;
      }
      return;
    }
    const children: unknown[] = Array.isArray(node)
      ? node
      : Object.values(node as Record<string, unknown>);
    fields += children.length;
    if (fields > DECISION_INPUT_LIMITS.maxFields) {
      tooManyFields = true;
    }
    for (const child of children) {
      walk(child, nodeDepth + 1);
    }
  };
  walk(value, 1);
  return { fields, depth, tooDeep, tooManyFields, nonFinite };
}

// -- validation ----------------------------------------------------------------

/**
 * Validate the decision input locally, mirroring the service's bounds.
 * The service stays authoritative: these checks only surface problems
 * before a request is sent.
 */
export function analyzeDecisionInput(mode: InputMode, text: string): InputAnalysis {
  if (mode === "text") {
    if (text.trim().length === 0) {
      return {
        issues: [{ location: "input", message: "must not be empty" }],
        stats: { sizeBytes: null, fieldCount: null, depth: null },
      };
    }
    // The service normalizes plain text to the state object {"text": ...}.
    const state: Record<string, unknown> = { text };
    const size = utf8ByteLength(serializeLikeService(state));
    const issues: InputIssue[] = [];
    if (size > DECISION_INPUT_LIMITS.maxSerializedBytes) {
      issues.push({
        location: "input",
        message: `is larger than ${DECISION_INPUT_LIMITS.maxSerializedBytes / 1024} KiB when serialized`,
      });
    }
    return {
      issues,
      stats: { sizeBytes: size, fieldCount: 1, depth: 1 },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      issues: [{ location: "input", message: "is not valid JSON" }],
      stats: { sizeBytes: null, fieldCount: null, depth: null },
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      issues: [{ location: "input", message: "must be a JSON object" }],
      stats: { sizeBytes: null, fieldCount: null, depth: null },
    };
  }
  const object = parsed as Record<string, unknown>;
  if (Object.keys(object).length === 0) {
    return {
      issues: [{ location: "input", message: "must not be empty" }],
      stats: { sizeBytes: null, fieldCount: null, depth: null },
    };
  }

  const measure = measureInput(object);
  const issues: InputIssue[] = [];
  if (measure.tooDeep) {
    issues.push({
      location: "input",
      message: `nesting exceeds ${DECISION_INPUT_LIMITS.maxDepth} levels`,
    });
  }
  if (measure.tooManyFields) {
    issues.push({
      location: "input",
      message: `has more than ${DECISION_INPUT_LIMITS.maxFields} fields`,
    });
  }
  if (measure.nonFinite) {
    issues.push({ location: "input", message: "numbers must be finite" });
  }
  const size = utf8ByteLength(serializeLikeService(object));
  if (size > DECISION_INPUT_LIMITS.maxSerializedBytes) {
    issues.push({
      location: "input",
      message: `is larger than ${DECISION_INPUT_LIMITS.maxSerializedBytes / 1024} KiB when serialized`,
    });
  }
  return {
    issues,
    stats: { sizeBytes: size, fieldCount: measure.fields, depth: measure.depth },
  };
}

// -- preflight warnings ----------------------------------------------------------

export interface PreflightContext {
  readonly mode: InputMode;
  readonly text: string;
  /** The selected recipe's full definition, when loaded. */
  readonly recipe: Recipe | null;
}

/**
 * Pre-run warnings: high-cardinality choice questions, ordinal score
 * questions, and inputs close to the service's documented limits. Hints
 * only - they never predict the model's answers.
 */
export function preflightWarnings(context: PreflightContext): PreflightWarning[] {
  const warnings: PreflightWarning[] = [];
  if (context.recipe !== null) {
    for (const [id, question] of Object.entries(context.recipe.questions)) {
      if (question.type === "choice") {
        const count = Object.keys(question.criteria).length;
        if (count > CHOICE_RECOMMENDED_MAX_OPTIONS) {
          warnings.push({
            code: "high_cardinality_choice",
            message: `Choice question "${id}" has ${count} options (recommended maximum ${CHOICE_RECOMMENDED_MAX_OPTIONS}); high-cardinality choices can be less reliable.`,
          });
        }
      } else if (question.type === "score") {
        warnings.push({
          code: "ordinal_question",
          message: `Score question "${id}" is an ordinal question, which is currently less reliable than choice and true/false questions.`,
        });
      }
    }
  }
  const analysis = analyzeDecisionInput(context.mode, context.text);
  const { sizeBytes, fieldCount, depth } = analysis.stats;
  if (
    sizeBytes !== null &&
    sizeBytes > DECISION_INPUT_LIMITS.maxSerializedBytes * NEAR_LIMIT_SHARE
  ) {
    warnings.push({
      code: "near_size_limit",
      message: `The input is close to the service's ${DECISION_INPUT_LIMITS.maxSerializedBytes / 1024} KiB serialized limit; the service may reject it.`,
    });
  }
  if (
    fieldCount !== null &&
    fieldCount > DECISION_INPUT_LIMITS.maxFields * NEAR_LIMIT_SHARE
  ) {
    warnings.push({
      code: "near_field_limit",
      message: `The input is close to the service's ${DECISION_INPUT_LIMITS.maxFields}-field limit; the service may reject it.`,
    });
  }
  if (depth !== null && depth > DECISION_INPUT_LIMITS.maxDepth * NEAR_LIMIT_SHARE) {
    warnings.push({
      code: "near_depth_limit",
      message: `The input is close to the service's ${DECISION_INPUT_LIMITS.maxDepth}-level nesting limit; deeper input would exceed the documented limit.`,
    });
  }
  return warnings;
}
