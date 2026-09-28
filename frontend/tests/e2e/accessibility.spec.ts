import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { launch, openScreen, SCREENS } from "./ui";

async function expectNoSeriousOrCritical(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const bad = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(
    bad.map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.nodes
          .map((node) => node.target.join(" "))
          .join("; ")}`,
    ),
    "axe serious/critical violations",
  ).toEqual([]);
}

/** The number of form controls without an accessible name. */
async function countUnnamedControls(page: Page): Promise<number> {
  return page.evaluate(() => {
    const controls = Array.from(
      document.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >("input, select, textarea"),
    );
    return controls.filter((control) => {
      const hasLabel = (control.labels?.length ?? 0) > 0;
      const aria = control.getAttribute("aria-label") ?? "";
      return !hasLabel && aria.trim() === "";
    }).length;
  });
}

test("no serious or critical accessibility violations on any screen", async ({
  page,
  service,
}) => {
  await launch(page, service);
  for (const [, name] of SCREENS) {
    await openScreen(page, name);
    await expectNoSeriousOrCritical(page);
  }
});

test("no serious or critical accessibility violations on the recovery screen", async ({
  page,
  service,
}) => {
  await launch(page, service, "not-the-token");
  await expect(page.getByTestId("recovery")).toBeVisible();
  await expectNoSeriousOrCritical(page);
});

test("no serious or critical accessibility violations in modal and form states", async ({
  page,
  service,
}) => {
  await launch(page, service);
  // The recipe form.
  await openScreen(page, "Recipes");
  await page.getByTestId("new-recipe").click();
  await expectNoSeriousOrCritical(page);
  await page.getByTestId("cancel").click();
  // The delete confirmation dialog.
  await page.getByTestId("delete-support-routing").click();
  await expect(page.getByTestId("delete-dialog")).toBeVisible();
  await expectNoSeriousOrCritical(page);
  await page.getByTestId("delete-cancel").click();
  // The settings confirmation dialog (whichever history state is active).
  await openScreen(page, "Settings");
  const on = (await page.getByTestId("history-state").textContent()) === "History: On";
  await page.getByTestId(on ? "clear-history" : "enable-history").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await expectNoSeriousOrCritical(page);
  await page.getByTestId("confirm-cancel").click();
  // A decision result, including its warnings and needs-review state.
  await openScreen(page, "Try a decision");
  await page.getByTestId("recipe-select").selectOption("email-triage");
  await page.getByTestId("decision-input").fill("[fake:low] [fake:truncate] Result state.");
  await page.getByTestId("run-decision").click();
  await expect(page.getByTestId("decision-result")).toBeVisible();
  await expectNoSeriousOrCritical(page);
});

test("landmarks, headings, and accessible names for every control", async ({
  page,
  service,
}) => {
  await launch(page, service);
  await expect(page.locator("header")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Screens" })).toBeVisible();
  await expect(page.locator("main")).toBeVisible();
  expect(await page.locator("h1").count()).toBe(1);
  await openScreen(page, "Try a decision");
  expect(await countUnnamedControls(page)).toBe(0);
  await openScreen(page, "Recipes");
  await page.getByTestId("new-recipe").click();
  expect(await countUnnamedControls(page)).toBe(0);
  await page.getByTestId("cancel").click();
  // The setup screen announces model states through a live region.
  await openScreen(page, "Setup");
  await expect(page.getByTestId("status-live").getAttribute("aria-live")).resolves.toBe(
    "polite",
  );
});

test("status meaning is carried by text, not color alone", async ({ page, service }) => {
  await launch(page, service);
  // The model state is plain text, one of the known labels.
  const state = (await page.getByTestId("state-typed-decisions").textContent()) ?? "";
  expect(state).toMatch(
    /(Installed|Downloading|Damaged \(verification failed\)|Not installed|Interrupted download)/,
  );
  // The per-state detail line repeats the state as text.
  await expect(page.getByTestId("phase-typed-decisions")).toContainText(state);
  // The review state is its own text block, separate from the probabilities.
  await openScreen(page, "Try a decision");
  await page.getByTestId("recipe-select").selectOption("email-triage");
  await page.getByTestId("decision-input").fill("Text for the a11y check.");
  await page.getByTestId("run-decision").click();
  const review = (await page.getByTestId("result-review-state").textContent()) ?? "";
  expect(review).toMatch(/(Ok|Needs review)/);
});
