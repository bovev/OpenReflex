import { expect, test as base } from "@playwright/test";
import { startFakeService, type FakeService } from "./fakeService";

/**
 * Shared fixtures for the browser suite.
 *
 * - ``service``: one test-only fake service per worker (deterministic fake
 *   engine, in-memory artifact source, real auth middleware, temporary data
 *   directory, no network access).
 * - ``networkGuard`` (auto): records every request the browser makes,
 *   blocks anything that is not loopback, and - after each test - asserts
 *   that no request ever targeted a non-loopback origin and that the page
 *   raised no CSP violation or uncaught error.
 */

export interface NetworkGuard {
  /** Every http(s) request URL the browser attempted. */
  readonly requests: string[];
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export const test = base.extend<{ networkGuard: NetworkGuard }, { service: FakeService }>({
  service: [
    // Playwright requires the object destructuring pattern for fixture args.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const service = await startFakeService();
      await use(service);
      await service.stop();
    },
    { scope: "worker" },
  ],
  networkGuard: async ({ page }, use) => {
    const requests: string[] = [];
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    await page.route("**/*", (route) => {
      const url = route.request().url();
      let hostname: string | undefined;
      try {
        hostname = new URL(url).hostname;
      } catch {
        hostname = undefined;
      }
      if (url.startsWith("http://") || url.startsWith("https://")) {
        requests.push(url);
        if (hostname !== undefined && !LOOPBACK_HOSTS.has(hostname)) {
          route.abort("blockedbyclient");
          return;
        }
      }
      route.continue();
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });
    await use({ requests });
    const offenders = requests.filter((url) => {
      const hostname = new URL(url).hostname;
      return !LOOPBACK_HOSTS.has(hostname);
    });
    expect(
      offenders,
      `requests left the loopback interface: ${offenders.join(", ")}`,
    ).toEqual([]);
    const cspFailures = [
      ...consoleErrors.filter((text) => text.includes("Content Security Policy")),
      ...consoleErrors.filter((text) => text.includes("Refused to")),
    ];
    expect(cspFailures, `CSP violations: ${cspFailures.join(" | ")}`).toEqual([]);
    expect(pageErrors, `uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
  },
});

export { expect };
