import { expect, test } from "./fixtures";
import { launch } from "./ui";

test("token fragment bootstrap: the app signs in and strips the fragment", async ({
  page,
  service,
}) => {
  await page.goto(`${service.baseUrl}/#token=${service.token}`);
  await expect(page.getByTestId("setup")).toBeVisible();
  await expect(page.getByTestId("service-reachability")).toContainText("Reachable");
  await expect(page.getByTestId("offline-ready")).toBeVisible();
  // The fragment is removed from the visible URL; the token stays tab-scoped.
  expect(new URL(page.url()).hash).not.toContain("token=");
});

test("without a token, the app shows the recovery screen", async ({ page, service }) => {
  await launch(page, service, "");
  await expect(page.getByTestId("recovery")).toBeVisible();
  await expect(page.getByTestId("recovery")).toContainText("Relaunch through OpenReflex");
  // No screen body renders without a sign-in.
  await expect(page.getByTestId("setup")).toBeHidden();
});

test("a rejected token shows the rejected recovery state", async ({ page, service }) => {
  await page.goto(`${service.baseUrl}/#token=not-the-service-token`);
  await expect(page.getByTestId("recovery")).toBeVisible();
  await expect(page.getByTestId("recovery")).toContainText("rejected");
});
