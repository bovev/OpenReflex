/**
 * Recipe operations against the local ``/v1`` API.
 *
 * Every operation goes through the authenticated same-origin client:
 * listing, reading, create, replace, validate-without-saving, import,
 * export, and the exact-id-confirmed delete. No filesystem access, no
 * local paths, no path- or URL-looking source fields: import sends the
 * bounded text of a file the user explicitly selected, and export reads
 * the service's YAML response.
 */

import { request, requestText, requestWithQuery } from "./api";
import type { Recipe, RecipeListing, ValidationReport } from "./recipeModel";

export function listRecipes(): Promise<RecipeListing> {
  return request<RecipeListing>("GET", "/v1/recipes");
}

export function getRecipe(id: string): Promise<Recipe> {
  return request<Recipe>("GET", `/v1/recipes/${id}`);
}

/** Validate and create. The payload is the form's exact schema fields. */
export function createRecipe(payload: Record<string, unknown>): Promise<Recipe> {
  return request<Recipe>("POST", "/v1/recipes", payload);
}

/** Validate and replace; the service requires the payload's id to match. */
export function replaceRecipe(id: string, payload: Record<string, unknown>): Promise<Recipe> {
  return request<Recipe>("PUT", `/v1/recipes/${id}`, payload);
}

/** Validate without saving. Never touches the recipe store. */
export function validateRecipe(payload: Record<string, unknown>): Promise<ValidationReport> {
  return request<ValidationReport>("POST", "/v1/recipes/validate", { recipe: payload });
}

/**
 * Import the bounded text of a user-selected YAML file. Only the text is
 * sent; the file's name and path never reach the service.
 */
export function importYaml(yaml: string, overwrite: boolean): Promise<Recipe> {
  return request<Recipe>("POST", "/v1/recipes/import", { yaml, overwrite });
}

/** Export the recipe as the service's YAML text. */
export function exportYaml(id: string): Promise<string> {
  return requestText("GET", `/v1/recipes/${id}/export`);
}

/**
 * Delete after confirmation: the service requires ``?confirm=<exact id>``;
 * the confirmation value is the recipe's own id, sent through the
 * strictly validated query parameter.
 */
export function deleteRecipe(id: string): Promise<void> {
  return requestWithQuery<void>("DELETE", `/v1/recipes/${id}`, [{ key: "confirm", value: id }]);
}
