/**
 * Decision execution against the local ``/v1`` API.
 *
 * Sends only the ``DecisionRequest`` shape (``recipe_id`` plus plain text
 * or a JSON object) to ``POST /v1/decisions`` through the authenticated
 * same-origin client. Input strings are inert content: they are carried in
 * the request body only, and no request is ever issued whose target is
 * derived from them - nothing is opened, resolved, uploaded, or fetched.
 *
 * There is deliberately no retry logic: a failed decision is reported to
 * the caller exactly once. A ``queue_full`` error carries the service's
 * retry hint (``Retry-After: 2``), which the UI shows as guidance the user
 * acts on explicitly by pressing "Run decision" again - never as an
 * implicit re-execution.
 *
 * Failure summaries are built from the service's safe error envelope
 * (``code``, ``message``, ``request_id``, ``issues``) only. Service error
 * messages are product-owned and documented as safe to show and log; they
 * never contain decision input, answers, or the result payload.
 */

import { ApiError, CanceledError, request } from "./api";
import type { ModelProfile } from "./types";

// -- wire types (mirror the backend's Pydantic models 1:1) ----------------

export type Review = "ok" | "needs_review";

export type DecisionStatus = "completed";

export type Device = "cpu" | "cuda" | "mps" | "fake";

export interface DecisionWarning {
  readonly code: string;
  readonly message: string;
  readonly question_id: string | null;
}

export interface ChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly probability: number;
  readonly confidence: number;
  readonly probabilities: Record<string, number>;
  readonly review: Review;
}

export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly level: number;
  readonly label: string;
  readonly probability: number;
  readonly confidence: number;
  readonly probabilities: readonly number[];
  readonly review: Review;
}

export interface NoulAnswer {
  readonly type: "noul";
  readonly value: boolean;
  readonly probability_true: number;
  readonly confidence: number;
  readonly review: Review;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface ModelInfo {
  readonly profile: ModelProfile;
  readonly resolved_profile: ModelProfile;
  readonly checkpoint: string;
  readonly revision: string;
  readonly device: Device;
}

export interface DecisionResult {
  readonly request_id: string;
  readonly recipe_id: string;
  readonly status: DecisionStatus;
  readonly review: Review;
  readonly model: ModelInfo;
  readonly answers: Record<string, Answer>;
  readonly warnings: readonly DecisionWarning[];
  readonly timing_ms: number;
  readonly contract_version: number;
}

/** The only shape the UI sends for a decision: a recipe id and inert input. */
export interface DecisionRequest {
  readonly recipe_id: string;
  readonly input: string | Record<string, unknown>;
}

/**
 * Run one recipe against one input. Exactly one request is issued per call;
 * cancellation goes through the signal, and a failure is thrown exactly
 * once (no implicit retry).
 */
export function runDecision(
  body: DecisionRequest,
  options: { readonly signal?: AbortSignal } = {},
): Promise<DecisionResult> {
  return request<DecisionResult>("POST", "/v1/decisions", body, options);
}

// -- failure classification ------------------------------------------------

export type FailureKind =
  | "canceled"
  | "queue_full"
  | "model_not_ready"
  | "model_not_found"
  | "model_busy"
  | "validation"
  | "recipe_not_found"
  | "timeout"
  | "engine_failure"
  | "failure"
  | "network";

export interface FailureIssue {
  readonly location: string;
  readonly message: string;
}

export interface FailureInfo {
  readonly kind: FailureKind;
  /** The service's safe, product-owned message. */
  readonly message: string;
  readonly requestId: string | null;
  readonly issues: readonly FailureIssue[];
  /** Product-owned guidance for this kind; never derived from input. */
  readonly hint: string;
}

const HINTS: Record<FailureKind, string> = {
  canceled:
    "Canceled in this tab. The service-side inference may still be running and may keep its queue slot until it finishes; a running model call cannot be interrupted. Nothing was retried.",
  queue_full: "The decision queue is full. Try again in about 2 seconds.",
  model_not_ready:
    "The model is not ready. Open the Setup screen to download it, then run the decision again.",
  model_not_found:
    "The model is not installed. Open the Setup screen to download it, then run the decision again.",
  model_busy: "The model is busy with another operation. Try again shortly.",
  validation:
    "The input was rejected before the model ran. Fix the input problem, then run the decision again.",
  recipe_not_found: "The recipe no longer exists. Reload the recipe list and try again.",
  timeout:
    "The decision took longer than the service's timeout. The service reports it as a timeout; try again.",
  engine_failure: "The engine failed to produce a decision. No answer was produced; try again.",
  failure: "The decision failed. No answer was produced; try again.",
  network: "Could not reach the local service. Check that OpenReflex is running, then try again.",
};

const CODE_TO_KIND: Record<string, FailureKind> = {
  queue_full: "queue_full",
  model_not_ready: "model_not_ready",
  model_not_found: "model_not_found",
  model_busy: "model_busy",
  invalid_input: "validation",
  input_too_large: "validation",
  recipe_not_found: "recipe_not_found",
  timeout: "timeout",
  engine_failure: "engine_failure",
  engine_incompatible: "engine_failure",
  internal: "engine_failure",
};

/**
 * Turn a thrown error into a safe, classifiable failure. The message is the
 * service's own (safe by contract) or a fixed fallback; the input and any
 * answer content never reach it.
 */
export function classifyFailure(error: unknown): FailureInfo {
  if (error instanceof CanceledError) {
    return {
      kind: "canceled",
      message: "the decision was canceled",
      requestId: null,
      issues: [],
      hint: HINTS.canceled,
    };
  }
  if (error instanceof ApiError) {
    // A status-0 error that is not a path/parse rejection is a network
    // failure (the service never produced an envelope).
    const kind =
      error.status === 0 && error.code === "network"
        ? "network"
        : (CODE_TO_KIND[error.code] ?? "failure");
    return {
      kind,
      message: error.message,
      requestId: error.requestId,
      issues: error.issues.map((issue) => ({ location: issue.location, message: issue.message })),
      hint: HINTS[kind],
    };
  }
  // Defensive fallback: never echo an unknown error's text, which could
  // contain anything.
  return {
    kind: "failure",
    message: "the decision failed",
    requestId: null,
    issues: [],
    hint: HINTS.failure,
  };
}

/**
 * A decision failure's diagnostic line: the stable kind, the request id,
 * and the number of validation issues. It never contains the decision
 * input, answers, or the result payload, so it is safe to show, log, or
 * copy into diagnostics.
 */
export function failureSummary(info: FailureInfo): string {
  return `decision failed: kind=${info.kind} request_id=${info.requestId ?? "none"} issues=${info.issues.length}`;
}
