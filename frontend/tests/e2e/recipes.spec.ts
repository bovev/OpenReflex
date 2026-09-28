import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures";
import { launch, openScreen } from "./ui";

function uniqueId(): string {
  return `e2e-recipe-${Date.now()}`;
}

test("create, edit, import, export, and delete a recipe", async ({ page, service }) => {
  const id = uniqueId();
  const importId = `${id}-imported`;
  await launch(page, service);
  await openScreen(page, "Recipes");

  // Create through the form.
  await page.getByTestId("new-recipe").click();
  await page.getByTestId("field-id").fill(id);
  await page.getByTestId("field-name").fill("E2E recipe");
  await page.getByTestId("field-description").fill("Created by the browser suite.");
  await page.getByTestId("q-id-0").fill("is_test");
  await page.getByTestId("q-instructions-0").fill("Is this a test?");
  await page.getByTestId("save").click();
  const row = page.getByTestId(`recipe-${id}`);
  await expect(row).toBeVisible();
  await expect(page.getByTestId(`label-${id}`)).toHaveText("Custom");

  // Edit.
  await page.getByTestId(`edit-${id}`).click();
  await page.getByTestId("field-name").fill("E2E recipe (edited)");
  await page.getByTestId("save").click();
  await expect(row).toContainText("E2E recipe (edited)");

  // Import through the file picker (the file's text goes to the service;
  // its name and path never do).
  const yaml = [
    "schema_version: 1",
    `id: ${importId}`,
    "name: Imported by the browser suite",
    "description: Imported through the file picker.",
    "model_profile: typed-decisions",
    "questions:",
    "  is_import: ",
    "    type: noul",
    "    instructions: Was this imported?",
    "review_policy:",
    "  default_min_confidence: 0.8",
    "  on_low_confidence: needs_review",
  ].join("\n");
  const file = path.join(tmpdir(), `${importId}.yaml`);
  await writeFile(file, yaml, "utf8");
  await page.getByTestId("import-file").setInputFiles(file);
  await expect(page.getByTestId(`recipe-${importId}`)).toBeVisible();

  // Export downloads the service's YAML response.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId(`export-${id}`).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`${id}.yaml`);
  const target = path.join(tmpdir(), `exported-${id}.yaml`);
  await download.saveAs(target);
  const exported = await readFile(target, "utf8");
  expect(exported).toContain("schema_version: 1");
  expect(exported).toContain(`id: ${id}`);

  // Delete requires typing the exact id.
  await page.getByTestId(`delete-${id}`).click();
  await expect(page.getByTestId("delete-dialog")).toBeVisible();
  const confirm = page.getByTestId("delete-confirm");
  await expect(confirm).toBeDisabled();
  await page.getByTestId("delete-confirm-input").fill(id);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByTestId(`recipe-${id}`)).toBeHidden();
});

test("unsaved edits are protected by the discard dialog", async ({ page, service }) => {
  await launch(page, service);
  await openScreen(page, "Recipes");
  await page.getByTestId("new-recipe").click();
  await page.getByTestId("field-name").fill("Unsaved changes");
  await openScreen(page, "Setup");
  await expect(page.getByTestId("discard-dialog")).toBeVisible();
  await page.getByTestId("discard-stay").click();
  await expect(page.getByTestId("discard-dialog")).toBeHidden();
  // The form survived, with its unsaved value.
  await expect(page.getByTestId("recipe-form")).toBeVisible();
  await expect(page.getByTestId("field-name")).toHaveValue("Unsaved changes");
  // Discarding, on the other hand, drops the form.
  await openScreen(page, "Setup");
  await expect(page.getByTestId("discard-dialog")).toBeVisible();
  await page.getByTestId("discard-go").click();
  await expect(page.getByTestId("recipe-form")).toBeHidden();
});

test("seeded examples are labeled as demonstrations", async ({ page, service }) => {
  await launch(page, service);
  await openScreen(page, "Recipes");
  await expect(page.getByTestId("recipe-email-triage")).toBeVisible();
  await expect(page.getByTestId("label-email-triage")).toHaveText(
    "Demonstration - not a production-validated policy",
  );
});
