import { expect, test } from "./fixtures";
import { launch, openScreen, SCREENS } from "./ui";

test("all five screens are reachable through the navigation", async ({ page, service }) => {
  await launch(page, service);
  for (const [, name] of SCREENS) {
    await openScreen(page, name);
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  }
});

test("landmarks, a single h1, and the current-screen state", async ({ page, service }) => {
  await launch(page, service);
  await expect(page.locator("header")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Screens" })).toBeVisible();
  await expect(page.locator("main")).toBeVisible();
  expect(await page.locator("h1").count()).toBe(1);
  for (const [id, name] of SCREENS) {
    await openScreen(page, name);
    await expect(page.locator(`a[data-screen="${id}"]`)).toHaveAttribute("aria-current", "page");
  }
});
