import type { Page } from "@playwright/test";
import type { FakeService } from "./fakeService";

/** The five V1 screens, in navigation order. */
export const SCREENS: ReadonlyArray<readonly [string, string]> = [
  ["setup", "Setup"],
  ["try-a-decision", "Try a decision"],
  ["recipes", "Recipes"],
  ["connections", "Connections"],
  ["settings", "Settings"],
];

/**
 * Launch the app the way the service's launcher does - with the bearer
 * token in the URL fragment - and wait for the connection state to settle
 * (either a ready app or the recovery screen).
 */
export async function launch(
  page: Page,
  service: FakeService,
  token: string = service.token,
): Promise<void> {
  await page.goto(token !== "" ? `${service.baseUrl}/#token=${token}` : `${service.baseUrl}/`);
  await page
    .locator('[data-testid="setup"], [data-testid="recovery"]')
    .first()
    .waitFor();
}

/** Navigate to a screen through its navigation link (public UI behavior). */
export async function openScreen(page: Page, name: string): Promise<void> {
  await page.getByRole("link", { name, exact: true }).click();
}
