import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * Keyboard-only paths: only Tab, Enter, and the typing keys are used after
 * the initial page load. No pointer input anywhere in these tests.
 */

async function tab(page: Page): Promise<void> {
  await page.keyboard.press("Tab");
}

async function isFocused(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element === document.activeElement);
}

/** The recipe list has loaded; its actions are disabled until then. */
async function recipesLoaded(page: Page): Promise<void> {
  await expect(page.getByTestId("recipe-email-triage")).toBeVisible();
  await expect(page.getByTestId("new-recipe")).toBeEnabled();
}

async function keyboardToScreen(page: Page, screen: string): Promise<void> {
  const order = ["Setup", "Try a decision", "Recipes", "Connections", "Settings"];
  for (const name of order.slice(0, order.indexOf(screen) + 1)) {
    await tab(page);
    await expect(page.getByRole("link", { name, exact: true })).toBeFocused();
  }
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: screen, level: 1 })).toBeFocused();
}

test("keyboard-only: navigate all five screens with Tab and Enter", async ({
  page,
  service,
}) => {
  await page.goto(`${service.baseUrl}/#token=${service.token}`);
  await page.locator('[data-testid="setup"]').waitFor();
  await keyboardToScreen(page, "Try a decision");
  // Activating a link moves focus to the new screen's heading; from there,
  // Shift+Tab walks back into the navigation (Settings is the last link).
  for (const name of ["Settings", "Connections", "Recipes", "Setup"]) {
    const link = page.getByRole("link", { name, exact: true });
    for (let i = 0; i < 5 && !(await isFocused(link)); i += 1) {
      await page.keyboard.press("Shift+Tab");
    }
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name, level: 1 })).toBeFocused();
  }
});

test("keyboard-only: create a recipe by tabbing through the form", async ({
  page,
  service,
}) => {
  const id = `a-e2e-kbd-${Date.now()}`;
  await page.goto(`${service.baseUrl}/#token=${service.token}`);
  await page.locator('[data-testid="setup"]').waitFor();
  await keyboardToScreen(page, "Recipes");
  await recipesLoaded(page);
  await tab(page);
  await expect(page.getByTestId("new-recipe")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("recipe-form")).toBeVisible();
  await tab(page);
  await expect(page.getByTestId("field-id")).toBeFocused();
  await page.keyboard.type(id);
  await tab(page);
  await page.keyboard.type("Keyboard recipe");
  await tab(page);
  await page.keyboard.type("Created with the keyboard only.");
  await tab(page); // profile (default)
  await tab(page); // threshold (default)
  await tab(page);
  await expect(page.getByTestId("q-id-0")).toBeFocused();
  await page.keyboard.type("is_kbd");
  await tab(page); // type (default: noul)
  await tab(page);
  await page.keyboard.type("Is this a keyboard test?");
  await tab(page); // per-question threshold (blank)
  await tab(page); // add-question (skip)
  await tab(page);
  await expect(page.getByTestId("save")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId(`recipe-${id}`)).toBeVisible();
  // Focus returns to the control that opened the form.
  await expect(page.getByTestId("new-recipe")).toBeFocused();
});

test("keyboard-only: run a decision", async ({ page, service }) => {
  await page.goto(`${service.baseUrl}/#token=${service.token}`);
  await page.locator('[data-testid="setup"]').waitFor();
  await keyboardToScreen(page, "Try a decision");
  await expect(page.getByTestId("recipe-select")).toBeEnabled();
  await tab(page);
  await expect(page.getByTestId("recipe-select")).toBeFocused();
  // Arrow keys until the example recipe is selected.
  for (let i = 0; i < 10; i += 1) {
    await page.keyboard.press("ArrowDown");
    if ((await page.getByTestId("recipe-select").inputValue()) === "email-triage") {
      break;
    }
  }
  await expect(page.getByTestId("recipe-select")).toHaveValue("email-triage");
  await tab(page); // the plain-text radio (already checked)
  await tab(page);
  await expect(page.getByTestId("decision-input")).toBeFocused();
  await page.keyboard.type("Keyboard decision input.");
  await tab(page);
  await expect(page.getByTestId("run-decision")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("decision-result")).toBeVisible();
  await expect(page.getByTestId("result-status")).toHaveText("completed");
});

test("keyboard-only: the delete confirmation dialog focuses, and focus is restored", async ({
  page,
  service,
}) => {
  const id = `a-e2e-kbd-del-${Date.now()}`;
  await page.goto(`${service.baseUrl}/#token=${service.token}`);
  await page.locator('[data-testid="setup"]').waitFor();
  await keyboardToScreen(page, "Recipes");
  await recipesLoaded(page);
  // Create the recipe, so its row is the first one (the id sorts first).
  await tab(page);
  await page.keyboard.press("Enter");
  await tab(page);
  await page.keyboard.type(id);
  await tab(page);
  await page.keyboard.type("Delete me");
  await tab(page);
  await tab(page);
  await tab(page);
  await tab(page);
  await page.keyboard.type("is_del");
  await tab(page);
  await tab(page);
  await page.keyboard.type("Is this deletable?");
  await tab(page);
  await tab(page);
  await tab(page);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId(`recipe-${id}`)).toBeVisible();
  // Focus is back on New recipe; Tab forward to this recipe's Delete button
  // (other tests' recipes may be listed before it on the shared service).
  await expect(page.getByTestId("new-recipe")).toBeFocused();
  const deleteButton = page.getByTestId(`delete-${id}`);
  for (let i = 0; i < 60 && !(await isFocused(deleteButton)); i += 1) {
    await tab(page);
  }
  await expect(page.getByTestId(`delete-${id}`)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("delete-dialog")).toBeVisible();
  // Focus moved into the dialog (the confirmation input).
  await expect(page.getByTestId("delete-confirm-input")).toBeFocused();
  await page.keyboard.type(id);
  await tab(page);
  await expect(page.getByTestId("delete-cancel")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("delete-dialog")).toBeHidden();
  // Focus was restored to the trigger, and the recipe still exists.
  await expect(page.getByTestId(`delete-${id}`)).toBeFocused();
  await expect(page.getByTestId(`recipe-${id}`)).toBeVisible();
});

test("keyboard-only: the settings confirmation dialog focuses", async ({ page, service }) => {
  await page.goto(`${service.baseUrl}/#token=${service.token}`);
  await page.locator('[data-testid="setup"]').waitFor();
  await keyboardToScreen(page, "Settings");
  const on = (await page.getByTestId("history-state").textContent()) === "History: On";
  if (on) {
    // History is on: open the "Clear history" confirmation (second button).
    await tab(page);
    await tab(page);
    await expect(page.getByTestId("clear-history")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await expect(page.getByTestId("confirm-input")).toBeFocused();
    await page.keyboard.type("clear");
    await tab(page);
    await expect(page.getByTestId("confirm-cancel")).toBeFocused();
    await tab(page);
    await expect(page.getByTestId("confirm-submit")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("history-state")).toHaveText("History: On");
  } else {
    await tab(page);
    await expect(page.getByTestId("enable-history")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await expect(page.getByTestId("confirm-input")).toBeFocused();
    await page.keyboard.type("enable");
    await tab(page);
    await expect(page.getByTestId("confirm-cancel")).toBeFocused();
    await tab(page);
    await expect(page.getByTestId("confirm-submit")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("history-state")).toHaveText("History: On");
  }
});

test("visible focus: keyboard focus shows a visible outline", async ({ page, service }) => {
  await page.goto(`${service.baseUrl}/#token=${service.token}`);
  await page.locator('[data-testid="setup"]').waitFor();
  const outline = async (): Promise<string> =>
    page.evaluate(() => {
      const element = document.activeElement;
      return element === null ? "" : getComputedStyle(element).outlineStyle;
    });
  await tab(page);
  await expect(page.getByRole("link", { name: "Setup", exact: true })).toBeFocused();
  expect(await outline()).toBe("solid");
  await tab(page); // Try a decision
  await tab(page); // Recipes
  await page.keyboard.press("Enter");
  await recipesLoaded(page);
  await tab(page);
  await expect(page.getByTestId("new-recipe")).toBeFocused();
  expect(await outline()).toBe("solid");
  await page.keyboard.press("Enter");
  await tab(page);
  await expect(page.getByTestId("field-id")).toBeFocused();
  expect(await outline()).toBe("solid");
});
