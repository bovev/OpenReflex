/**
 * Try-a-decision screen: select a recipe, paste plain text or a JSON
 * object, run it, and inspect the complete result.
 *
 * Inert input. The input is plain text or a JSON object only. Strings
 * that look like paths or URLs are accepted as inert content and are
 * carried in the request body only: nothing in this screen opens,
 * resolves, uploads, fetches, or otherwise retrieves them, and no request
 * target is ever derived from the input.
 *
 * One request per run. "Run decision" issues exactly one
 * ``POST /v1/decisions`` and is disabled while a decision is in flight,
 * so a decision can never be submitted twice. There is no automatic
 * retry: a failure is reported once, with guidance for the specific
 * failure kind (queue saturation with the service's retry hint, model not
 * ready, validation, timeout, engine failure), and only an explicit user
 * click runs the decision again. Cancellation aborts the client's wait
 * for the result; the service-side inference may still be running and
 * keep its queue slot until it finishes (a running model call cannot be
 * interrupted), and a canceled result is discarded.
 *
 * Privacy. The user's input lives in component memory only (never in
 * storage). Errors and the failure's diagnostic line are built from the
 * service's safe error envelope (message, request id, issue
 * location/message) and a fixed kind label: decision input, answers, and
 * the full result payload never reach error text, the diagnostic line, or
 * any console logging.
 *
 * Preflight. Before running, the screen warns about high-cardinality
 * choice questions, ordinal score questions, and inputs close to the
 * service's documented limits. These are hints against documented limits;
 * they never predict the model's answers.
 *
 * Rendering. The result shows every field of the contract envelope:
 * status, review state, all warnings, the actual checkpoint and pinned
 * revision, and latency. The review state is displayed in its own block,
 * separately from every probability, with the standing note that neither
 * confidence nor review state proves correctness. Probabilities and
 * confidences are shown at the exact precision the service returned, with
 * an approximate percentage alongside (never rounded in place of the raw
 * value). Status is carried by text (and structure), never by color alone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, CanceledError } from "./api";
import {
  classifyFailure,
  failureSummary,
  runDecision,
  type FailureInfo,
  type NoulAnswer,
  type ScoreAnswer,
  type ChoiceAnswer,
  type DecisionResult,
} from "./decisionApi";
import {
  analyzeDecisionInput,
  preflightWarnings,
  type InputMode,
} from "./decisionModel";
import { getRecipe, listRecipes } from "./recipeApi";
import type { Recipe, RecipeSummary } from "./recipeModel";

/**
 * Show the exact value the service returned, with an approximate
 * percentage alongside. The raw value is never rounded in place of
 * itself (e.g. 0.9999 stays 0.9999, not 100.0%). ``String`` gives the
 * shortest round-trip decimal for a JavaScript number, so the displayed
 * value is the one the service sent.
 */
function formatProbability(value: number): string {
  return `${value} (≈ ${(value * 100).toFixed(1)}%)`;
}

function ReviewState({ review, testId }: { review: "ok" | "needs_review"; testId: string }) {
  return (
    <span className="review-state" data-testid={testId}>
      {review === "needs_review" ? "needs review" : "ok"}
    </span>
  );
}

function AnswerCard({ questionId, answer }: { questionId: string; answer: DecisionResult["answers"][string] }) {
  const review = (
    <p>
      Answer review: <ReviewState review={answer.review} testId={`answer-${questionId}-review`} />
    </p>
  );
  if (answer.type === "choice") {
    const choice = answer as ChoiceAnswer;
    return (
      <article className="answer-card" data-testid={`answer-${questionId}`}>
        <h3>
          {questionId} <span className="answer-type">(choice)</span>
        </h3>
        <p>
          Chosen option: <strong>{choice.choice}</strong>
        </p>
        <p data-testid={`answer-${questionId}-probability`}>
          Probability of the chosen option: {formatProbability(choice.probability)}
        </p>
        <p data-testid={`answer-${questionId}-confidence`}>
          Engine confidence (what the review policy uses): {formatProbability(choice.confidence)}
        </p>
        <ul className="distribution" data-testid={`answer-${questionId}-distribution`}>
          {Object.entries(choice.probabilities).map(([key, probability]) => (
            <li key={key}>
              {key}: {formatProbability(probability)}
            </li>
          ))}
        </ul>
        {review}
      </article>
    );
  }
  if (answer.type === "score") {
    const score = answer as ScoreAnswer;
    return (
      <article className="answer-card" data-testid={`answer-${questionId}`}>
        <h3>
          {questionId} <span className="answer-type">(score)</span>
        </h3>
        <p data-testid={`answer-${questionId}-score`}>
          Score: {score.score} - level {score.level}: <strong>{score.label}</strong>
        </p>
        <p data-testid={`answer-${questionId}-probability`}>
          Probability of the level: {formatProbability(score.probability)}
        </p>
        <p data-testid={`answer-${questionId}-confidence`}>
          Engine confidence (what the review policy uses): {formatProbability(score.confidence)}
        </p>
        <ul className="distribution" data-testid={`answer-${questionId}-distribution`}>
          {score.probabilities.map((probability, index) => (
            <li key={index}>
              level {index}: {formatProbability(probability)}
            </li>
          ))}
        </ul>
        {review}
      </article>
    );
  }
  const noul = answer as NoulAnswer;
  return (
    <article className="answer-card" data-testid={`answer-${questionId}`}>
      <h3>
        {questionId} <span className="answer-type">(noul)</span>
      </h3>
      <p data-testid={`answer-${questionId}-value`}>
        Value: <strong>{noul.value ? "true" : "false"}</strong>
      </p>
      <p data-testid={`answer-${questionId}-probability`}>
        Probability of true: {formatProbability(noul.probability_true)}
      </p>
      <p data-testid={`answer-${questionId}-confidence`}>
        Engine confidence (what the review policy uses): {formatProbability(noul.confidence)}
      </p>
      {review}
    </article>
  );
}

export function DecisionScreen() {
  const [summaries, setSummaries] = useState<readonly RecipeSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [recipeId, setRecipeId] = useState("");
  const [recipeDetail, setRecipeDetail] = useState<Recipe | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [mode, setMode] = useState<InputMode>("text");
  const [inputText, setInputText] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DecisionResult | null>(null);
  const [failure, setFailure] = useState<FailureInfo | null>(null);
  const [canceled, setCanceled] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadList = useCallback(async () => {
    setListError(null);
    try {
      const listing = await listRecipes();
      if (!Array.isArray(listing.recipes) || !Array.isArray(listing.invalid)) {
        throw new ApiError(
          0,
          "invalid_listing",
          "the service returned an unreadable recipe list",
          null,
          [],
        );
      }
      setSummaries(listing.recipes);
    } catch (error) {
      setSummaries(null);
      setListError(
        error instanceof ApiError ? error.message : "could not reach the local service",
      );
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // Leaving the screen aborts the client's wait for the in-flight
  // request. The service-side inference may keep running and hold its
  // queue slot until it finishes (a running model call cannot be
  // interrupted); aborting only stops the UI from waiting for it.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  // The selected recipe's full definition, for preflight warnings (best
  // effort: a failed read only disables the recipe-based warnings; the
  // service stays authoritative when the decision runs).
  useEffect(() => {
    if (recipeId === "") {
      setRecipeDetail(null);
      setDetailError(null);
      return;
    }
    let active = true;
    setDetailError(null);
    getRecipe(recipeId)
      .then((recipe) => {
        if (active) {
          setRecipeDetail(recipe);
        }
      })
      .catch((error) => {
        if (active) {
          setRecipeDetail(null);
          setDetailError(
            error instanceof ApiError ? error.message : "could not reach the local service",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [recipeId]);

  const analysis = useMemo(() => analyzeDecisionInput(mode, inputText), [mode, inputText]);
  const warnings = useMemo(
    () => preflightWarnings({ mode, text: inputText, recipe: recipeDetail }),
    [mode, inputText, recipeDetail],
  );

  const canRun = !running && recipeId !== "" && analysis.issues.length === 0;

  const run = useCallback(async () => {
    if (running || recipeId === "" || analysis.issues.length > 0) {
      return;
    }
    setResult(null);
    setFailure(null);
    setCanceled(false);
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const input =
      mode === "text"
        ? inputText
        : (JSON.parse(inputText) as Record<string, unknown>);
    try {
      const next = await runDecision(
        { recipe_id: recipeId, input },
        { signal: controller.signal },
      );
      setResult(next);
    } catch (error) {
      if (error instanceof CanceledError) {
        setCanceled(true);
      } else {
        setFailure(classifyFailure(error));
      }
    } finally {
      setRunning(false);
    }
  }, [running, recipeId, analysis.issues, mode, inputText]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <div data-testid="decision">
      <section aria-labelledby="decision-recipe-heading" className="decision-section">
        <h2 id="decision-recipe-heading">Recipe</h2>
        {listError !== null && (
          <div role="alert" data-testid="decision-recipes-error">
            <p>Could not load the recipe list: {listError}</p>
            <button type="button" data-testid="decision-recipes-retry" onClick={() => void loadList()}>
              Try again
            </button>
          </div>
        )}
        {summaries === null && listError === null && (
          <p data-testid="decision-recipes-loading">Loading the recipe list&hellip;</p>
        )}
        {summaries !== null && (
          <div className="field">
            <label htmlFor="decision-recipe-select">Recipe</label>
            <select
              id="decision-recipe-select"
              data-testid="recipe-select"
              value={recipeId}
              disabled={running}
              onChange={(event) => setRecipeId(event.target.value)}
            >
              <option value="">Select a recipe</option>
              {summaries.map((summary) => (
                <option key={summary.id} value={summary.id}>
                  {summary.id} - {summary.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {detailError !== null && (
          <p className="error" data-testid="recipe-detail-error">
            Preflight checks for this recipe are unavailable: {detailError}
          </p>
        )}
      </section>

      <section aria-labelledby="decision-input-heading" className="decision-section">
        <h2 id="decision-input-heading">Input</h2>
        <div className="radio-row" role="radiogroup" aria-label="Input kind">
          <label>
            <input
              type="radio"
              name="input-mode"
              data-testid="input-mode-text"
              checked={mode === "text"}
              disabled={running}
              onChange={() => setMode("text")}
            />{" "}
            Plain text
          </label>
          <label>
            <input
              type="radio"
              name="input-mode"
              data-testid="input-mode-json"
              checked={mode === "json"}
              disabled={running}
              onChange={() => setMode("json")}
            />{" "}
            JSON object
          </label>
        </div>
        <div className="field">
          <label htmlFor="decision-input">
            {mode === "text" ? "Text" : "JSON object"}
          </label>
          <textarea
            id="decision-input"
            data-testid="decision-input"
            value={inputText}
            rows={6}
            disabled={running}
            onChange={(event) => setInputText(event.target.value)}
          />
        </div>
        <p data-testid="input-note">
          Plain text or a JSON object only. Text that looks like a path or a URL is inert
          content: it is sent to the service as-is and is never opened, resolved, uploaded, or
          fetched.
        </p>
        {analysis.issues.length > 0 && (
          // ``role="alert"`` lives on the wrapper, not the ``<ul>``: putting it
          // on the list would override the list role and orphan the ``<li>``
          // items (an axe serious violation).
          <div role="alert" data-testid="input-issues">
            <ul className="issues">
              {analysis.issues.map((issue, i) => (
                <li key={i}>
                  <code>{issue.location}</code> {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {warnings.length > 0 && (
        <section aria-labelledby="preflight-heading" className="decision-section">
          <h2 id="preflight-heading">Before you run</h2>
          <ul className="warning-list" data-testid="preflight-warnings">
            {warnings.map((warning, i) => (
              <li key={i} data-testid={`preflight-${warning.code}`}>
                {warning.message}
              </li>
            ))}
          </ul>
          <p data-testid="preflight-disclaimer">
            These pre-run checks compare the recipe and the input against documented limits.
            They do not predict the model's answers.
          </p>
        </section>
      )}

      <div className="actions">
        <button
          type="button"
          data-testid="run-decision"
          disabled={!canRun}
          onClick={() => void run()}
        >
          {running ? "Running..." : "Run decision"}
        </button>
        {running && (
          <button type="button" data-testid="cancel-decision" onClick={cancel}>
            Cancel
          </button>
        )}
      </div>

      {running && (
        <p role="status" data-testid="decision-running">
          Running the decision&hellip;
        </p>
      )}
      {canceled && (
        <p role="status" data-testid="decision-canceled">
          Canceled in this tab. The service-side inference may still be running and may keep
          its queue slot until it finishes - a running model call cannot be interrupted.
          Nothing was retried.
        </p>
      )}
      {failure !== null && (
        <div role="alert" data-testid="decision-failure">
          <p data-testid="failure-message">{failure.message}</p>
          <p data-testid="failure-hint">{failure.hint}</p>
          {failure.issues.length > 0 && (
            <ul className="failure-list" data-testid="failure-issues">
              {failure.issues.map((issue, i) => (
                <li key={i}>
                  <code>{issue.location}</code> {issue.message}
                </li>
              ))}
            </ul>
          )}
          <p data-testid="failure-summary">{failureSummary(failure)}</p>
        </div>
      )}

      {result !== null && (
        <section aria-labelledby="result-heading" data-testid="decision-result">
          <h2 id="result-heading">Result</h2>
          <dl className="facts">
            <div>
              <dt>Status</dt>
              <dd data-testid="result-status">{result.status}</dd>
            </div>
            <div>
              <dt>Recipe</dt>
              <dd>{result.recipe_id}</dd>
            </div>
            <div>
              <dt>Request id</dt>
              <dd data-testid="result-request-id">{result.request_id}</dd>
            </div>
            <div>
              <dt>Result contract version</dt>
              <dd data-testid="result-contract">{result.contract_version}</dd>
            </div>
            <div>
              <dt>Latency</dt>
              <dd data-testid="result-timing">{result.timing_ms} ms</dd>
            </div>
            <div>
              <dt>Model profile</dt>
              <dd data-testid="result-profile">{result.model.profile}</dd>
            </div>
            <div>
              <dt>Resolved profile</dt>
              <dd data-testid="result-resolved-profile">{result.model.resolved_profile}</dd>
            </div>
            <div>
              <dt>Checkpoint</dt>
              <dd data-testid="result-checkpoint">{result.model.checkpoint}</dd>
            </div>
            <div>
              <dt>Pinned revision</dt>
              <dd data-testid="result-revision">{result.model.revision}</dd>
            </div>
            <div>
              <dt>Device</dt>
              <dd data-testid="result-device">{result.model.device}</dd>
            </div>
          </dl>

          <div
            className={`review-banner${result.review === "needs_review" ? " needed" : ""}`}
            role="status"
            data-testid="result-review"
          >
            <p data-testid="result-review-state">
              Review state:{" "}
              <strong>{result.review === "needs_review" ? "Needs review" : "Ok"}</strong>
            </p>
            <p data-testid="result-review-note">
              {result.review === "needs_review"
                ? "The review policy flagged this decision (confidence below a question's threshold and/or truncation). Review is a routing signal for a human check; it is not a claim that the answers are wrong."
                : "No answer fell below its review threshold and no truncation was reported. The review state is a routing signal, not a claim that the answers are correct."}{" "}
              Neither the confidence nor the review state proves correctness.
            </p>
          </div>

          <section aria-label="Warnings">
            {result.warnings.length > 0 ? (
              <ul className="warning-list" data-testid="result-warnings">
                {result.warnings.map((warning, i) => (
                  <li key={i} data-testid={`warning-${warning.code}`}>
                    <code>{warning.code}</code>
                    {warning.question_id !== null ? ` (question ${warning.question_id})` : ""}{" "}
                    {warning.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p data-testid="result-no-warnings">No warnings.</p>
            )}
          </section>

          {Object.entries(result.answers).map(([questionId, answer]) => (
            <AnswerCard key={questionId} questionId={questionId} answer={answer} />
          ))}
        </section>
      )}
    </div>
  );
}
