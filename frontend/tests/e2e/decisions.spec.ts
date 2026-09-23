import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { launch, openScreen } from "./ui";
import type { FakeService } from "./fakeService";

async function selectEmailTriage(page: Page, service: FakeService): Promise<void> {
  await launch(page, service);
  await openScreen(page, "Try a decision");
  await page.getByTestId("recipe-select").selectOption("email-triage");
}

test("a plain-text decision shows all three answer primitives", async ({ page, service }) => {
  await selectEmailTriage(page, service);
  // The score question's preflight warning is shown before the run.
  await expect(page.getByTestId("preflight-ordinal_question")).toBeVisible();
  await page.getByTestId("decision-input").fill(
    "[fake:high] We were charged twice for invoice 4471. Please refund.",
  );
  await page.getByTestId("run-decision").click();
  await expect(page.getByTestId("decision-result")).toBeVisible();
  await expect(page.getByTestId("result-status")).toHaveText("completed");
  await expect(page.getByTestId("result-contract")).toHaveText("1");
  // All three primitives: choice, noul, and score.
  await expect(page.getByTestId("answer-department")).toBeVisible();
  await expect(page.getByTestId("answer-department")).toContainText("(choice)");
  await expect(page.getByTestId("answer-urgent")).toBeVisible();
  await expect(page.getByTestId("answer-urgent")).toContainText("(noul)");
  await expect(page.getByTestId("answer-priority")).toBeVisible();
  await expect(page.getByTestId("answer-priority")).toContainText("(score)");
  // The actual checkpoint and pinned revision are reported.
  await expect(page.getByTestId("result-checkpoint")).toHaveText("fake/typed-decisions");
  await expect(page.getByTestId("result-revision")).toHaveText("fake-0");
  // The standing score warning is shown; the review state is still Ok, and
  // it is displayed separately from the probabilities.
  await expect(page.getByTestId("warning-score_weak")).toBeVisible();
  await expect(page.getByTestId("result-review-state")).toContainText("Ok");
  await expect(page.getByTestId("answer-department-probability")).toContainText("≈");
});

test("a JSON-object decision accepts inert URL-looking text", async ({ page, service }) => {
  await selectEmailTriage(page, service);
  await page.getByTestId("input-mode-json").check();
  await page.getByTestId("decision-input").fill(
    JSON.stringify({
      subject: "Refund",
      body: "see https://example.com/order/4471 and C:\\invoices\\4471",
    }),
  );
  await page.getByTestId("run-decision").click();
  await expect(page.getByTestId("decision-result")).toBeVisible();
  await expect(page.getByTestId("result-status")).toHaveText("completed");
});

test("low confidence forces the needs review state", async ({ page, service }) => {
  await selectEmailTriage(page, service);
  await page.getByTestId("decision-input").fill("[fake:low] A flat, low-confidence decision.");
  await page.getByTestId("run-decision").click();
  await expect(page.getByTestId("result-review-state")).toContainText("Needs review");
  // The per-answer review state is flagged too, while the raw probability
  // is still shown next to it.
  await expect(page.getByTestId("answer-department-review")).toHaveText("needs review");
  await expect(page.getByTestId("answer-department-probability")).toContainText("≈");
  // One low-confidence warning per affected question.
  await expect(page.getByTestId("warning-low_confidence").first()).toBeVisible();
});

test("a truncation warning is shown and forces review", async ({ page, service }) => {
  await selectEmailTriage(page, service);
  await page.getByTestId("decision-input").fill("[fake:truncate] The input was cut off.");
  await page.getByTestId("run-decision").click();
  await expect(page.getByTestId("warning-input_truncated")).toBeVisible();
  await expect(page.getByTestId("result-review-state")).toContainText("Needs review");
});

test("an invalid JSON input is surfaced before any request", async ({ page, service }) => {
  await selectEmailTriage(page, service);
  await page.getByTestId("input-mode-json").check();
  await page.getByTestId("decision-input").fill("{ not valid json");
  await expect(page.getByTestId("input-issues")).toBeVisible();
  await expect(page.getByTestId("input-issues")).toContainText("is not valid JSON");
  await expect(page.getByTestId("run-decision")).toBeDisabled();
});
