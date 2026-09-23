import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { launch, openScreen } from "./ui";

async function ensureNotInstalled(page: Page): Promise<void> {
  await openScreen(page, "Settings");
  const state = page.getByTestId("model-state-typed-decisions");
  if ((await state.textContent()) === "Installed") {
    await page.getByTestId("remove-typed-decisions").click();
    await page.getByTestId("confirm-input").fill("typed-decisions");
    await page.getByTestId("confirm-submit").click();
    await expect(state).toHaveText("Not installed");
  }
  await openScreen(page, "Setup");
}

test("model download through the UI: not installed, progress, installed, offline ready", async ({
  page,
  service,
}) => {
  await launch(page, service);
  await ensureNotInstalled(page);
  const state = page.getByTestId("state-typed-decisions");
  await expect(state).toHaveText("Not installed");
  await expect(page.getByTestId("offline-ready")).toContainText("No");
  await page.getByTestId("download-typed-decisions").click();
  // The fake source is instant, but the UI observes it on its 1s poll.
  await expect(state).toHaveText("Installed", { timeout: 30_000 });
  await expect(page.getByTestId("offline-ready")).toContainText("Yes");
  await expect(page.getByTestId("verified-typed-decisions")).toBeVisible();
  // The announced status carries the model states as text.
  await expect(page.getByTestId("status-live")).toContainText("typed-decisions");
});

test("the service facts are shown and the diagnostics panel is safe", async ({
  page,
  service,
}) => {
  await launch(page, service);
  await expect(page.getByTestId("service-status")).toBeVisible();
  await expect(page.getByTestId("service-reachability")).toContainText("Reachable");
  await expect(page.getByTestId("setup")).toContainText("OpenReflex");
  await page.getByTestId("diagnostics-toggle").click();
  await expect(page.getByTestId("diagnostics-preview")).toBeVisible();
  await expect(page.getByTestId("diagnostics-preview")).toContainText("Product");
});
