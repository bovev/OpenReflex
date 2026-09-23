import { expect, test } from "./fixtures";
import { launch, openScreen } from "./ui";

test("generated MCP configurations are shown and copyable", async ({ page, service }) => {
  await launch(page, service);
  await openScreen(page, "Connections");
  // The privacy explanation comes before any setup step.
  await expect(page.getByTestId("privacy-note")).toBeVisible();
  await expect(page.getByTestId("configuration-policy")).toBeVisible();
  for (const client of ["claude-code", "opencode", "vscode-copilot"]) {
    const snippet = page.getByTestId(`config-${client}`);
    await expect(snippet).toBeVisible();
    const text = (await snippet.textContent()) ?? "";
    expect(text).toContain("openreflex");
    await page.getByTestId(`copy-${client}`).click();
    await expect(page.getByTestId(`copy-status-${client}`)).toContainText(
      "Copied to the clipboard.",
    );
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain("openreflex");
    // The setup, verification, restart, and removal steps are all shown.
    await expect(page.getByTestId(`setup-steps-${client}`)).toBeVisible();
    await expect(page.getByTestId(`verification-steps-${client}`)).toBeVisible();
    await expect(page.getByTestId(`restart-steps-${client}`)).toBeVisible();
    await expect(page.getByTestId(`removal-steps-${client}`)).toBeVisible();
  }
});
