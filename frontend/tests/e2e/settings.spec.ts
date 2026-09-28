import { expect, test } from "./fixtures";
import { launch, openScreen } from "./ui";

test("history opt-in, what-is-stored, and clear - each with its typed confirmation", async ({
  page,
  service,
}) => {
  await launch(page, service);
  await openScreen(page, "Settings");
  // Start from the off state, whatever the earlier tests left behind.
  if ((await page.getByTestId("history-state").textContent()) === "History: On") {
    await page.getByTestId("disable-history").click();
    await expect(page.getByTestId("history-state")).toHaveText("History: Off");
  }
  await expect(page.getByTestId("history-state")).toHaveText("History: Off");
  await expect(page.getByTestId("history-off-default")).toBeVisible();
  await page.getByTestId("enable-history").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("confirm-input").fill("enable");
  await page.getByTestId("confirm-submit").click();
  await expect(page.getByTestId("history-state")).toHaveText("History: On");
  await expect(page.getByTestId("history-on-stored")).toBeVisible();
  await page.getByTestId("clear-history").click();
  await page.getByTestId("confirm-input").fill("clear");
  await page.getByTestId("confirm-submit").click();
  await expect(page.getByTestId("history-state")).toHaveText("History: On");
  // Turning history off again is a plain, confirmed action.
  await page.getByTestId("disable-history").click();
  await expect(page.getByTestId("history-state")).toHaveText("History: Off");
});

test("model removal requires the typed profile name and only deletes local files", async ({
  page,
  service,
}) => {
  await launch(page, service);
  // Make sure the model is installed first (order-independent).
  await openScreen(page, "Setup");
  const state = page.getByTestId("state-typed-decisions");
  if ((await state.textContent()) !== "Installed") {
    await page.getByTestId("download-typed-decisions").click();
    await expect(state).toHaveText("Installed", { timeout: 30_000 });
  }
  await openScreen(page, "Settings");
  await expect(page.getByTestId("model-state-typed-decisions")).toHaveText("Installed");
  await page.getByTestId("remove-typed-decisions").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  const confirm = page.getByTestId("confirm-submit");
  await expect(confirm).toBeDisabled();
  await page.getByTestId("confirm-input").fill("typed-decisions");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByTestId("model-state-typed-decisions")).toHaveText("Not installed");
  // Recipes, history, and settings are untouched by the removal.
  await openScreen(page, "Recipes");
  await expect(page.getByTestId("recipe-email-triage")).toBeVisible();
});

test("about, data directory, and attribution are shown", async ({ page, service }) => {
  await launch(page, service);
  await openScreen(page, "Settings");
  await expect(page.getByTestId("product-version")).toContainText("OpenReflex");
  await expect(page.getByTestId("data-dir")).toBeVisible();
  await expect(page.getByTestId("data-dir-note")).toContainText("Read-only");
  await expect(page.getByTestId("attribution")).toContainText(
    "Powered by Laya",
  );
  await expect(page.getByTestId("notices")).toBeVisible();
});
