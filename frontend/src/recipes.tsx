/**
 * Recipes screen: form-based listing, creation, editing, duplication,
 * validation, import, export, and deletion - all through the documented
 * ``/v1`` API. Nothing touches the recipe directory or a local path.
 *
 * - The form is the single source of truth for every payload: only the
 *   schema-version-1 fields exist in it, so an unknown or invalid field
 *   cannot be silently discarded and saved as if valid. Client-side
 *   validation mirrors the service's rules; the service stays
 *   authoritative and its issues are shown field-level (location + message
 *   only - no recipe content is echoed into logs or error text).
 * - Seeded examples are labeled as demonstrations, not
 *   production-validated policies.
 * - YAML stays secondary: import reads only a file the user explicitly
 *   selected and sends its text bounded to the service's 64 KiB UTF-8 byte
 *   limit (oversized files are rejected before reading, and a read failure
 *   is reported); the file's name and path are never sent. Export downloads
 *   the service's YAML response.
 * - Deletion requires typing the exact id and goes to
 *   ``DELETE /v1/recipes/<id>?confirm=<id>``.
 * - Unsaved edits are protected by a leave confirmation, and a save or
 *   validate is never issued twice: the action buttons are disabled while
 *   a request is in flight.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "./api";
import { useDialogFocus } from "./dialogFocus";
import type { ScreenId } from "./app";
import {
  createRecipe,
  deleteRecipe,
  exportYaml,
  getRecipe,
  importYaml,
  listRecipes,
  replaceRecipe,
  validateRecipe,
} from "./recipeApi";
import {
  LIMITS,
  formFromRecipe,
  groupIssues,
  newRecipeForm,
  toPayload,
  validateForm,
  type FormIssue,
  type Issue,
  type QuestionForm,
  type RecipeForm,
  type RecipeListing,
  type ValidationReport,
} from "./recipeModel";
import type { ModelProfile } from "./types";

export type LeaveGuard = (target: ScreenId) => boolean;

type Mode = "create" | "edit" | "duplicate";

interface FormView {
  readonly mode: Mode;
  readonly baseId: string | null;
}

type Busy = "load" | "save" | "validate" | "import" | "overwrite" | "delete" | "export" | null;

const PROFILES: readonly ModelProfile[] = [
  "typed-decisions",
  "english",
  "multilingual",
  "auto",
];

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "could not reach the local service";
}

/**
 * Read the text of a user-selected file. ``File.text()`` is the standard
 * path; a ``FileReader`` fallback keeps the same behaviour in test
 * environments whose ``File`` lacks it.
 */
async function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * The UTF-8 encoded byte length of ``text`` - the same unit the service
 * bounds the imported YAML by (a 64 KiB UTF-8 byte limit), not the UTF-16
 * code-unit length a JavaScript string reports. ``TextEncoder`` is available
 * in the browser and in the test environment.
 */
function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function IssueList({ issues, testId }: { issues: readonly (Issue | FormIssue)[]; testId: string }) {
  if (issues.length === 0) {
    return null;
  }
  return (
    // ``role="alert"`` lives on the wrapper, not the ``<ul>``: putting it on the
    // list would override the list role and orphan the ``<li>`` items (an axe
    // serious violation). The wrapper announces; the list keeps its semantics.
    <div role="alert" data-testid={testId}>
      <ul className="issues">
        {issues.map((issue, i) => (
          <li key={i}>
            <code>{issue.location}</code> {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Dialog({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="dialog"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
    >
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function RecipesScreen({
  setLeaveGuard,
}: {
  setLeaveGuard: (guard: LeaveGuard | null) => void;
}) {
  const [list, setList] = useState<RecipeListing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [view, setView] = useState<FormView | null>(null);
  const [form, setForm] = useState<RecipeForm>(() => newRecipeForm());
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [clientIssues, setClientIssues] = useState<FormIssue[]>([]);
  const [serverIssues, setServerIssues] = useState<Issue[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importConflict, setImportConflict] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteText, setDeleteText] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingNav, setPendingNav] = useState<ScreenId | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const lastImportText = useRef<string | null>(null);
  // The ``data-testid`` of the control that opened the form; focus returns
  // there when the form closes, once the list is interactive again.
  const returnFocus = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy("load");
    try {
      const listing = await listRecipes();
      if (!Array.isArray(listing.recipes) || !Array.isArray(listing.invalid)) {
        throw new ApiError(
          0,
          "invalid_listing",
          "the service returned an unreadable recipe list",
          null,
          [],
        );
      }
      setList(listing);
      setListError(null);
    } catch (error) {
      setListError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The leave guard is active only while the form has unsaved edits.
  useEffect(() => {
    if (view !== null && dirty) {
      setLeaveGuard((target) => {
        setPendingNav(target);
        return true;
      });
      return () => setLeaveGuard(null);
    }
    setLeaveGuard(null);
    return undefined;
  }, [view, dirty, setLeaveGuard]);

  const clearFormState = useCallback(() => {
    setClientIssues([]);
    setServerIssues([]);
    setServerError(null);
    setReport(null);
  }, []);

  const openCreate = useCallback(() => {
    returnFocus.current = "new-recipe";
    setForm(newRecipeForm());
    setView({ mode: "create", baseId: null });
    setDirty(false);
    clearFormState();
  }, [clearFormState]);

  const openExisting = useCallback(
    async (mode: "edit" | "duplicate", id: string) => {
      setBusy("load");
      try {
        const recipe = await getRecipe(id);
        const loaded = formFromRecipe(recipe);
        if (mode === "duplicate") {
          // Suggest a new id; the user confirms or changes it.
          loaded.id =
            loaded.id.length <= LIMITS.recipeId - "-copy".length ? `${loaded.id}-copy` : "";
        }
        setForm(loaded);
        returnFocus.current = `${mode}-${id}`;
        setView({ mode, baseId: id });
        setDirty(false);
        clearFormState();
      } catch (error) {
        setListError(errorMessage(error));
      } finally {
        setBusy(null);
      }
    },
    [clearFormState],
  );

  useEffect(() => {
    if (view === null && busy === null && returnFocus.current !== null) {
      const target = document.querySelector<HTMLElement>(
        `[data-testid="${returnFocus.current}"]`,
      );
      returnFocus.current = null;
      target?.focus();
    }
  }, [view, busy]);

  const mutate = useCallback(
    (updater: (current: RecipeForm) => RecipeForm) => {
      setForm(updater);
      setDirty(true);
      setClientIssues([]);
    },
    [],
  );

  const updateQuestion = useCallback(
    (index: number, patch: Partial<QuestionForm>) => {
      mutate((current) => ({
        ...current,
        questions: current.questions.map((q, i) => (i === index ? { ...q, ...patch } : q)),
      }));
    },
    [mutate],
  );

  const addQuestion = useCallback(() => {
    mutate((current) => ({
      ...current,
      questions: [
        ...current.questions,
        { id: "", type: "noul", instructions: "", minConfidence: "", options: [], levels: [] },
      ],
    }));
  }, [mutate]);

  const removeQuestion = useCallback(
    (index: number) => {
      mutate((current) =>
        current.questions.length <= 1
          ? current
          : { ...current, questions: current.questions.filter((_, i) => i !== index) },
      );
    },
    [mutate],
  );

  const moveQuestion = useCallback(
    (index: number, delta: number) => {
      mutate((current) => {
        const target = index + delta;
        if (target < 0 || target >= current.questions.length) {
          return current;
        }
        const questions = [...current.questions];
        const [moved] = questions.splice(index, 1);
        questions.splice(target, 0, moved);
        return { ...current, questions };
      });
    },
    [mutate],
  );

  const updateOption = useCallback(
    (index: number, optionIndex: number, patch: Partial<{ key: string; description: string }>) => {
      mutate((current) => ({
        ...current,
        questions: current.questions.map((q, i) =>
          i === index
            ? {
                ...q,
                options: q.options.map((o, j) => (j === optionIndex ? { ...o, ...patch } : o)),
              }
            : q,
        ),
      }));
    },
    [mutate],
  );

  const addOption = useCallback(
    (index: number) => {
      mutate((current) => ({
        ...current,
        questions: current.questions.map((q, i) =>
          i === index ? { ...q, options: [...q.options, { key: "", description: "" }] } : q,
        ),
      }));
    },
    [mutate],
  );

  const removeOption = useCallback(
    (index: number, optionIndex: number) => {
      mutate((current) => ({
        ...current,
        questions: current.questions.map((q, i) =>
          i === index ? { ...q, options: q.options.filter((_, j) => j !== optionIndex) } : q,
        ),
      }));
    },
    [mutate],
  );

  const moveOption = useCallback(
    (index: number, optionIndex: number, delta: number) => {
      mutate((current) => ({
        ...current,
        questions: current.questions.map((q, i) => {
          if (i !== index) {
            return q;
          }
          const target = optionIndex + delta;
          if (target < 0 || target >= q.options.length) {
            return q;
          }
          const options = [...q.options];
          const [moved] = options.splice(optionIndex, 1);
          options.splice(target, 0, moved);
          return { ...q, options };
        }),
      }));
    },
    [mutate],
  );

  const updateLevel = useCallback(
    (index: number, levelIndex: number, value: string) => {
      mutate((current) => ({
        ...current,
        questions: current.questions.map((q, i) =>
          i === index
            ? {
                ...q,
                levels: q.levels.map((level, j) => (j === levelIndex ? value : level)),
              }
            : q,
        ),
      }));
    },
    [mutate],
  );

  const addLevel = useCallback(
    (index: number) => {
      mutate((current) => ({
        ...current,
        questions: current.questions.map((q, i) =>
          i === index ? { ...q, levels: [...q.levels, ""] } : q,
        ),
      }));
    },
    [mutate],
  );

  const removeLevel = useCallback(
    (index: number, levelIndex: number) => {
      mutate((current) => ({
        ...current,
        questions: current.questions.map((q, i) =>
          i === index ? { ...q, levels: q.levels.filter((_, j) => j !== levelIndex) } : q,
        ),
      }));
    },
    [mutate],
  );

  const moveLevel = useCallback(
    (index: number, levelIndex: number, delta: number) => {
      mutate((current) => ({
        ...current,
        questions: current.questions.map((q, i) => {
          if (i !== index) {
            return q;
          }
          const target = levelIndex + delta;
          if (target < 0 || target >= q.levels.length) {
            return q;
          }
          const levels = [...q.levels];
          const [moved] = levels.splice(levelIndex, 1);
          levels.splice(target, 0, moved);
          return { ...q, levels };
        }),
      }));
    },
    [mutate],
  );

  const save = useCallback(async () => {
    if (view === null || busy !== null) {
      return;
    }
    const reserved = view.mode === "duplicate" ? view.baseId : null;
    const validation = validateForm(form, reserved);
    if (validation.issues.length > 0) {
      setClientIssues(validation.issues);
      return;
    }
    setClientIssues([]);
    setServerError(null);
    setServerIssues([]);
    setBusy("save");
    try {
      const payload = toPayload(form);
      if (view.mode === "edit") {
        await replaceRecipe(view.baseId as string, payload);
      } else {
        await createRecipe(payload);
      }
      setView(null);
      setDirty(false);
      await refresh();
    } catch (error) {
      if (error instanceof ApiError) {
        setServerIssues([...error.issues]);
        setServerError(error.message);
      } else {
        setServerError(errorMessage(error));
      }
    } finally {
      setBusy(null);
    }
  }, [view, busy, form, refresh]);

  const validate = useCallback(async () => {
    if (view === null || busy !== null) {
      return;
    }
    const reserved = view.mode === "duplicate" ? view.baseId : null;
    const validation = validateForm(form, reserved);
    if (validation.issues.length > 0) {
      setClientIssues(validation.issues);
      return;
    }
    setClientIssues([]);
    setServerError(null);
    setServerIssues([]);
    setBusy("validate");
    try {
      setReport(await validateRecipe(toPayload(form)));
    } catch (error) {
      setReport(null);
      setServerError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }, [view, busy, form]);

  const cancel = useCallback(() => {
    if (dirty) {
      setConfirmCancel(true);
    } else {
      setView(null);
    }
  }, [dirty]);

  const discardAndGo = useCallback(() => {
    const target = pendingNav;
    setLeaveGuard(null);
    setPendingNav(null);
    setConfirmCancel(false);
    setView(null);
    setDirty(false);
    if (target !== null) {
      window.location.hash = `#/${target}`;
    }
  }, [pendingNav, setLeaveGuard]);

  const onImportFile = useCallback(
    async (file: File | null) => {
      if (file === null || busy !== null) {
        return;
      }
      setImportError(null);
      setImportConflict(false);
      // Reject an oversized file before reading it into memory.
      if (file.size > LIMITS.yamlBytes) {
        setImportError(`the YAML is larger than ${LIMITS.yamlBytes / 1024} KiB`);
        return;
      }
      let text: string;
      try {
        text = await readFileText(file);
      } catch {
        setImportError("could not read the selected file");
        return;
      }
      // Enforce the service's 64 KiB UTF-8 byte bound on the decoded text
      // (not the UTF-16 code-unit length).
      if (utf8ByteLength(text) > LIMITS.yamlBytes) {
        setImportError(`the YAML is larger than ${LIMITS.yamlBytes / 1024} KiB`);
        return;
      }
      lastImportText.current = text;
      setBusy("import");
      try {
        await importYaml(text, false);
        await refresh();
      } catch (error) {
        if (error instanceof ApiError && error.code === "recipe_exists") {
          setImportConflict(true);
        } else {
          setImportError(errorMessage(error));
        }
      } finally {
        setBusy(null);
      }
    },
    [busy, refresh],
  );

  const importOverwrite = useCallback(async () => {
    if (lastImportText.current === null || busy !== null) {
      return;
    }
    setBusy("overwrite");
    setImportError(null);
    try {
      await importYaml(lastImportText.current, true);
      setImportConflict(false);
      await refresh();
    } catch (error) {
      setImportConflict(false);
      setImportError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }, [busy, refresh]);

  const exportRecipe = useCallback(
    async (id: string) => {
      if (busy !== null) {
        return;
      }
      setBusy("export");
      setImportError(null);
      try {
        const text = await exportYaml(id);
        const blob = new Blob([text], { type: "application/yaml" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${id}.yaml`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      } catch (error) {
        setImportError(errorMessage(error));
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  const openDelete = useCallback((id: string) => {
    setDeleteTarget(id);
    setDeleteText("");
    setDeleteError(null);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (deleteTarget === null || busy !== null) {
      return;
    }
    setBusy("delete");
    setDeleteError(null);
    try {
      await deleteRecipe(deleteTarget);
      setDeleteTarget(null);
      setDeleteText("");
      await refresh();
    } catch (error) {
      setDeleteError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }, [deleteTarget, busy, refresh]);

  const allIssues = useMemo(() => [...clientIssues, ...serverIssues], [clientIssues, serverIssues]);
  const grouped = useMemo(() => groupIssues(allIssues, form), [allIssues, form]);

  // The discard confirmation is reachable from the form (navigation or
  // cancel), so it renders in both views.
  const leaveDialog =
    pendingNav !== null || confirmCancel ? (
      <Dialog title="Discard unsaved changes?" testId="discard-dialog">
        <p>
          {confirmCancel
            ? "You have unsaved changes. Canceling this form will discard them."
            : "You have unsaved changes. Leaving this form will discard them."}
        </p>
        <div className="actions">
          <button
            type="button"
            data-testid="discard-stay"
            onClick={() => {
              setPendingNav(null);
              setConfirmCancel(false);
            }}
          >
            Stay
          </button>
          <button type="button" data-testid="discard-go" onClick={discardAndGo}>
            Discard changes
          </button>
        </div>
      </Dialog>
    ) : null;

  if (listError !== null && view === null) {
    return (
      <div data-testid="recipes">
        <div role="alert" data-testid="recipes-error">
          <p>Could not load the recipe list: {listError}</p>
          <button type="button" data-testid="recipes-retry" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (view === null) {
    return (
      <div data-testid="recipes">
        <div className="actions">
          <button
            type="button"
            data-testid="new-recipe"
            disabled={busy !== null}
            onClick={openCreate}
          >
            New recipe
          </button>
          <label className="file-label">
            Import YAML
            <input
              type="file"
              accept=".yaml,.yml"
              data-testid="import-file"
              disabled={busy !== null}
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                event.target.value = "";
                void onImportFile(file);
              }}
            />
          </label>
        </div>
        {importConflict && (
          <p role="alert" data-testid="import-conflict">
            A recipe with this id already exists.
            <button
              type="button"
              data-testid="import-overwrite"
              disabled={busy !== null}
              onClick={() => void importOverwrite()}
            >
              Overwrite it
            </button>
          </p>
        )}
        {importError !== null && (
          <p role="alert" data-testid="import-error">
            {importError}
          </p>
        )}
        {list === null ? (
          <p data-testid="recipes-loading">Loading the recipe list&hellip;</p>
        ) : (
          <>
            <table className="recipe-table" data-testid="recipe-table">
              <thead>
                <tr>
                  <th scope="col">Id</th>
                  <th scope="col">Name</th>
                  <th scope="col">Description</th>
                  <th scope="col">Model</th>
                  <th scope="col">Questions</th>
                  <th scope="col">Label</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.recipes.map((recipe) => (
                  <tr key={recipe.id} data-testid={`recipe-${recipe.id}`}>
                    <td>{recipe.id}</td>
                    <td>{recipe.name}</td>
                    <td>{recipe.description}</td>
                    <td>{recipe.model_profile}</td>
                    <td>{recipe.question_count}</td>
                    <td data-testid={`label-${recipe.id}`}>
                      {recipe.example
                        ? "Demonstration - not a production-validated policy"
                        : "Custom"}
                    </td>
                    <td>
                      <button
                        type="button"
                        data-testid={`edit-${recipe.id}`}
                        disabled={busy !== null}
                        onClick={() => void openExisting("edit", recipe.id)}
                      >
                        Edit
                      </button>{" "}
                      <button
                        type="button"
                        data-testid={`duplicate-${recipe.id}`}
                        disabled={busy !== null}
                        onClick={() => void openExisting("duplicate", recipe.id)}
                      >
                        Duplicate
                      </button>{" "}
                      <button
                        type="button"
                        data-testid={`export-${recipe.id}`}
                        disabled={busy !== null}
                        onClick={() => void exportRecipe(recipe.id)}
                      >
                        Export
                      </button>{" "}
                      <button
                        type="button"
                        data-testid={`delete-${recipe.id}`}
                        disabled={busy !== null}
                        onClick={() => openDelete(recipe.id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {list.invalid.length > 0 && (
              <div role="alert" data-testid="invalid-recipes">
                <p>Some recipe files are invalid and are not shown:</p>
                <ul>
                  {list.invalid.map((entry) => (
                    <li key={entry.id}>
                      {entry.id}: {entry.issues.map((issue) => issue.message).join("; ")}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        {deleteTarget !== null && (
          <Dialog title="Delete recipe" testId="delete-dialog">
            <p>
              Delete <code>{deleteTarget}</code>? This cannot be undone.
            </p>
            <label>
              Type the exact id to confirm:
              <input
                data-testid="delete-confirm-input"
                value={deleteText}
                autoComplete="off"
                onChange={(event) => setDeleteText(event.target.value)}
              />
            </label>
            {deleteError !== null && (
              <p role="alert" data-testid="delete-error">
                {deleteError}
              </p>
            )}
            <div className="actions">
              <button
                type="button"
                data-testid="delete-cancel"
                disabled={busy === "delete"}
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteText("");
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="delete-confirm"
                disabled={deleteText !== deleteTarget || busy === "delete"}
                onClick={() => void confirmDelete()}
              >
                Delete {deleteTarget}
              </button>
            </div>
          </Dialog>
        )}
        {leaveDialog}
      </div>
    );
  }

  const modeText =
    view.mode === "create"
      ? "New recipe"
      : view.mode === "edit"
        ? `Editing ${view.baseId}`
        : `Duplicate of ${view.baseId} - choose a new id`;

  return (
    <div data-testid="recipes">
      <form
        data-testid="recipe-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p data-testid="form-mode">{modeText}</p>
        <div className="field">
          <label htmlFor="recipe-id">Id</label>
          <input
            id="recipe-id"
            data-testid="field-id"
            value={form.id}
            disabled={view.mode === "edit"}
            autoComplete="off"
            onChange={(event) =>
              mutate((current) => ({ ...current, id: event.target.value }))
            }
          />
          <IssueList issues={grouped.top.id ?? []} testId="issues-id" />
        </div>
        <div className="field">
          <label htmlFor="recipe-name">Name</label>
          <input
            id="recipe-name"
            data-testid="field-name"
            value={form.name}
            onChange={(event) =>
              mutate((current) => ({ ...current, name: event.target.value }))
            }
          />
          <IssueList issues={grouped.top.name ?? []} testId="issues-name" />
        </div>
        <div className="field">
          <label htmlFor="recipe-description">Description</label>
          <textarea
            id="recipe-description"
            data-testid="field-description"
            value={form.description}
            rows={2}
            onChange={(event) =>
              mutate((current) => ({ ...current, description: event.target.value }))
            }
          />
          <IssueList issues={grouped.top.description ?? []} testId="issues-description" />
        </div>
        <div className="field">
          <label htmlFor="recipe-profile">Model profile</label>
          <select
            id="recipe-profile"
            data-testid="field-profile"
            value={form.modelProfile}
            onChange={(event) =>
              mutate((current) => ({
                ...current,
                modelProfile: event.target.value as ModelProfile,
              }))
            }
          >
            {PROFILES.map((profile) => (
              <option key={profile} value={profile}>
                {profile}
              </option>
            ))}
          </select>
          <IssueList issues={grouped.top.model_profile ?? []} testId="issues-profile" />
        </div>
        <div className="field">
          <label htmlFor="recipe-threshold">
            Review threshold (confidence below it forces needs review)
          </label>
          <input
            id="recipe-threshold"
            data-testid="field-threshold"
            value={form.defaultMinConfidence}
            inputMode="decimal"
            onChange={(event) =>
              mutate((current) => ({
                ...current,
                defaultMinConfidence: event.target.value,
              }))
            }
          />
          <p data-testid="policy-action">
            On low confidence: <strong>needs review</strong> - the only V1 action.
          </p>
          <IssueList
            issues={grouped.top["review_policy.default_min_confidence"] ?? []}
            testId="issues-threshold"
          />
        </div>

        <section aria-labelledby="questions-heading">
          <h2 id="questions-heading">Questions</h2>
          {form.questions.map((question, index) => (
            <fieldset key={index} className="question-card" data-testid={`question-${index}`}>
              <legend>Question {index + 1}</legend>
              <div className="field">
                <label htmlFor={`q-id-${index}`}>Question id</label>
                <input
                  id={`q-id-${index}`}
                  data-testid={`q-id-${index}`}
                  value={question.id}
                  autoComplete="off"
                  onChange={(event) =>
                    updateQuestion(index, { id: event.target.value })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor={`q-type-${index}`}>Type</label>
                <select
                  id={`q-type-${index}`}
                  data-testid={`q-type-${index}`}
                  value={question.type}
                  onChange={(event) =>
                    updateQuestion(index, { type: event.target.value as QuestionForm["type"] })
                  }
                >
                  <option value="choice">choice - pick one option</option>
                  <option value="score">score - ordered levels</option>
                  <option value="noul">noul - true/false probability</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor={`q-instructions-${index}`}>Instructions</label>
                <textarea
                  id={`q-instructions-${index}`}
                  data-testid={`q-instructions-${index}`}
                  value={question.instructions}
                  rows={2}
                  onChange={(event) =>
                    updateQuestion(index, { instructions: event.target.value })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor={`q-threshold-${index}`}>
                  Review threshold (optional; blank = recipe default)
                </label>
                <input
                  id={`q-threshold-${index}`}
                  data-testid={`q-threshold-${index}`}
                  value={question.minConfidence}
                  inputMode="decimal"
                  onChange={(event) =>
                    updateQuestion(index, { minConfidence: event.target.value })
                  }
                />
              </div>
              {question.type === "choice" && (
                <div className="criteria">
                  <p>Options ({question.options.length})</p>
                  {question.options.map((option, optionIndex) => (
                    <div
                      key={optionIndex}
                      className="option-row"
                      data-testid={`option-${index}-${optionIndex}`}
                    >
                      <input
                        data-testid={`option-key-${index}-${optionIndex}`}
                        value={option.key}
                        autoComplete="off"
                        aria-label={`Option key ${optionIndex + 1} of question ${index + 1}`}
                        onChange={(event) =>
                          updateOption(index, optionIndex, { key: event.target.value })
                        }
                      />
                      <input
                        data-testid={`option-description-${index}-${optionIndex}`}
                        value={option.description}
                        aria-label={`Option description ${optionIndex + 1} of question ${index + 1}`}
                        onChange={(event) =>
                          updateOption(index, optionIndex, {
                            description: event.target.value,
                          })
                        }
                      />
                      <button
                        type="button"
                        data-testid={`option-up-${index}-${optionIndex}`}
                        disabled={optionIndex === 0}
                        onClick={() => moveOption(index, optionIndex, -1)}
                      >
                        Up
                      </button>
                      <button
                        type="button"
                        data-testid={`option-down-${index}-${optionIndex}`}
                        disabled={optionIndex === question.options.length - 1}
                        onClick={() => moveOption(index, optionIndex, 1)}
                      >
                        Down
                      </button>
                      <button
                        type="button"
                        data-testid={`option-remove-${index}-${optionIndex}`}
                        disabled={question.options.length <= LIMITS.choiceMinOptions}
                        onClick={() => removeOption(index, optionIndex)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    data-testid={`add-option-${index}`}
                    onClick={() => addOption(index)}
                  >
                    Add option
                  </button>
                </div>
              )}
              {question.type === "score" && (
                <div className="criteria">
                  <p>Levels, lowest first ({question.levels.length})</p>
                  {question.levels.map((level, levelIndex) => (
                    <div
                      key={levelIndex}
                      className="option-row"
                      data-testid={`level-${index}-${levelIndex}`}
                    >
                      <input
                        data-testid={`level-input-${index}-${levelIndex}`}
                        value={level}
                        aria-label={`Level ${levelIndex + 1} of question ${index + 1}`}
                        onChange={(event) =>
                          updateLevel(index, levelIndex, event.target.value)
                        }
                      />
                      <button
                        type="button"
                        data-testid={`level-up-${index}-${levelIndex}`}
                        disabled={levelIndex === 0}
                        onClick={() => moveLevel(index, levelIndex, -1)}
                      >
                        Up
                      </button>
                      <button
                        type="button"
                        data-testid={`level-down-${index}-${levelIndex}`}
                        disabled={levelIndex === question.levels.length - 1}
                        onClick={() => moveLevel(index, levelIndex, 1)}
                      >
                        Down
                      </button>
                      <button
                        type="button"
                        data-testid={`level-remove-${index}-${levelIndex}`}
                        disabled={question.levels.length <= LIMITS.scoreMinLevels}
                        onClick={() => removeLevel(index, levelIndex)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    data-testid={`add-level-${index}`}
                    onClick={() => addLevel(index)}
                  >
                    Add level
                  </button>
                </div>
              )}
              <IssueList
                issues={grouped.questions[index] ?? []}
                testId={`issues-question-${index}`}
              />
              <div className="actions">
                <button
                  type="button"
                  data-testid={`question-up-${index}`}
                  disabled={index === 0}
                  onClick={() => moveQuestion(index, -1)}
                >
                  Move up
                </button>
                <button
                  type="button"
                  data-testid={`question-down-${index}`}
                  disabled={index === form.questions.length - 1}
                  onClick={() => moveQuestion(index, 1)}
                >
                  Move down
                </button>
                <button
                  type="button"
                  data-testid={`question-remove-${index}`}
                  disabled={form.questions.length <= 1}
                  onClick={() => removeQuestion(index)}
                >
                  Remove
                </button>
              </div>
            </fieldset>
          ))}
          <button
            type="button"
            data-testid="add-question"
            disabled={form.questions.length >= LIMITS.maxQuestions}
            onClick={addQuestion}
          >
            Add question
          </button>
        </section>

        <div className="actions">
          <button type="submit" data-testid="save" disabled={busy !== null}>
            {busy === "save" ? "Saving..." : view.mode === "edit" ? "Save changes" : "Save"}
          </button>
          <button
            type="button"
            data-testid="validate"
            disabled={busy !== null}
            onClick={() => void validate()}
          >
            Validate
          </button>
          <button type="button" data-testid="cancel" onClick={cancel}>
            Cancel
          </button>
        </div>
        {serverError !== null && (
          <p className="error" role="alert" data-testid="server-error">
            {serverError}
          </p>
        )}
        <IssueList issues={grouped.general} testId="issues-general" />
        {report !== null && (
          <section className="validate-report" data-testid="validate-report" aria-label="Validation report">
            <p data-testid="report-valid">
              {report.valid ? "Valid" : "Invalid"} - nothing was saved.
            </p>
            {report.issues.length > 0 && (
              <ul data-testid="report-issues">
                {report.issues.map((issue, i) => (
                  <li key={i}>
                    <code>{issue.location}</code> {issue.message}
                  </li>
                ))}
              </ul>
            )}
            {report.warnings.length > 0 && (
              <ul data-testid="report-warnings">
                {report.warnings.map((warning, i) => (
                  <li key={i}>
                    <code>{warning.code}</code>
                    {warning.question_id !== null ? ` (${warning.question_id})` : ""}{" "}
                    {warning.message}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </form>
      {leaveDialog}
    </div>
  );
}
