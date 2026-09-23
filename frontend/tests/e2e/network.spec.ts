import { expect, test } from "./fixtures";
import { openScreen, SCREENS } from "./ui";

test("production assets work under the real CSP, with no non-loopback requests", async ({
  page,
  service,
  networkGuard,
}) => {
  const response = await page.goto(`${service.baseUrl}/#token=${service.token}`);
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  await expect(page.getByTestId("setup")).toBeVisible();
  // Walk every screen so all API and asset requests are exercised.
  for (const [, name] of SCREENS.slice(1)) {
    await openScreen(page, name);
  }
  // The production bundle was served by the local service.
  expect(networkGuard.requests.some((url) => url.includes("/assets/"))).toBe(true);
  // No request targeted anything but the loopback service - no external
  // asset, analytics, model, or API request was made.
  const hosts = [...new Set(networkGuard.requests.map((url) => new URL(url).hostname))];
  expect(hosts).toEqual(["127.0.0.1"]);
});
