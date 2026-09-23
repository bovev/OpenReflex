/**
 * Settings screen: app and version information, the read-only data
 * directory, the server-owned Laya attribution, bundled project and
 * third-party notices, the history opt-in/opt-out and clear controls,
 * local model removal, and the shared safe diagnostics.
 *
 * History stays off by default. The screen shows the API's exact
 * ``what_is_stored`` explanation before opt-in, and enabling history and
 * clearing history each require a distinct explicit confirmation (type
 * the exact word). Only ``/v1/preferences`` and ``/v1/history`` are
 * used for history.
 *
 * Model removal is separate from uninstalling the application: it only
 * deletes the model's local files through
 * ``DELETE /v1/models/<profile>?confirm=<profile>`` (the exact profile
 * name must be typed to confirm), and it never touches recipes,
 * history, or settings. The data directory is read-only information:
 * there is no control on this screen that moves or renames it, and no
 * request this screen sends can.
 *
 * Every destructive control is disabled while its operation is pending,
 * and structured API failures are rendered as the service's
 * product-owned messages - never retried implicitly.
 */

import { useCallback, useEffect, useState } from "react";
import { ApiError, CanceledError, request, requestWithQuery } from "./api";
import { NOTICES } from "./notices";
import { DiagnosticsPanel, deriveOfflineReady, mergeModel, stateLabel } from "./setup";
import { humanBytes, type ModelStatus, type Preferences, type StatusReport } from "./types";

type BusyAction =
  | { kind: "enable-history" }
  | { kind: "disable-history" }
  | { kind: "clear-history" }
  | { kind: "remove-model"; profile: string };

type Confirmation =
  | { kind: "enable-history" }
  | { kind: "clear-history" }
  | { kind: "remove-model"; profile: string };

export function SettingsScreen() {
  const [report, setReport] = useState<StatusReport | null>(null);
  const [historyEnabled, setHistoryEnabled] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [confirmText, setConfirmText] = useState("");

  // One status read (product, version, data directory, models, the
  // API's what_is_stored text) and one read of the authoritative
  // history preference. Nothing else is sent on load.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const [status, prefs] = await Promise.all([
          request<StatusReport>("GET", "/v1/status", undefined, { signal: controller.signal }),
          request<Preferences>("GET", "/v1/preferences", undefined, { signal: controller.signal }),
        ]);
        if (
          !Array.isArray(status.models) ||
          typeof status.data_dir !== "string" ||
          typeof prefs.history_enabled !== "boolean"
        ) {
          throw new ApiError(
            0,
            "invalid_settings",
            "the service returned an unreadable settings payload",
            null,
            [],
          );
        }
        setLoadError(null);
        setReport(status);
        setHistoryEnabled(prefs.history_enabled);
      } catch (error) {
        if (error instanceof CanceledError) {
          return;
        }
        setReport(null);
        setHistoryEnabled(null);
        setLoadError(
          error instanceof ApiError ? error.message : "could not reach the local service",
        );
      }
    })();
    return () => controller.abort();
  }, [reloadKey]);

  const setHistory = useCallback(async (enabled: boolean) => {
    setActionError(null);
    setBusy(enabled ? { kind: "enable-history" } : { kind: "disable-history" });
    try {
      const next = await request<Preferences>("PUT", "/v1/preferences", {
        history_enabled: enabled,
      });
      if (typeof next.history_enabled !== "boolean") {
        throw new ApiError(
          0,
          "invalid_preferences",
          "the service returned an unreadable preference",
          null,
          [],
        );
      }
      setHistoryEnabled(next.history_enabled);
      setReport((prev) =>
        prev === null
          ? prev
          : { ...prev, history: { ...prev.history, enabled: next.history_enabled } },
      );
    } catch (error) {
      if (error instanceof CanceledError) {
        return;
      }
      setActionError(
        error instanceof ApiError ? error.message : "could not update the history preference",
      );
    } finally {
      setBusy(null);
    }
  }, []);

  const clearHistory = useCallback(async () => {
    setActionError(null);
    setBusy({ kind: "clear-history" });
    try {
      await request("DELETE", "/v1/history");
    } catch (error) {
      if (error instanceof CanceledError) {
        return;
      }
      setActionError(error instanceof ApiError ? error.message : "could not clear the history");
    } finally {
      setBusy(null);
    }
  }, []);

  const removeModel = useCallback(async (profile: string) => {
    setActionError(null);
    setBusy({ kind: "remove-model", profile });
    try {
      const next = await requestWithQuery<ModelStatus>("DELETE", `/v1/models/${profile}`, [
        { key: "confirm", value: profile },
      ]);
      if (typeof next.profile !== "string" || typeof next.state !== "string") {
        throw new ApiError(
          0,
          "invalid_model",
          "the service returned an unreadable model state",
          null,
          [],
        );
      }
      setReport((prev) =>
        prev === null ? prev : { ...prev, models: mergeModel(prev.models, next) },
      );
    } catch (error) {
      if (error instanceof CanceledError) {
        return;
      }
      setActionError(error instanceof ApiError ? error.message : "could not remove the model");
    } finally {
      setBusy(null);
    }
  }, []);

  if (loadError !== null) {
    return (
      <div role="alert" data-testid="settings-error">
        <p>Could not load the settings: {loadError}</p>
        <button
          type="button"
          data-testid="settings-retry"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          Try again
        </button>
      </div>
    );
  }
  if (report === null) {
    return <p data-testid="settings-loading">Loading the settings&hellip;</p>;
  }

  const offlineReady = deriveOfflineReady(report.default_profile, report.models);

  return (
    <div data-testid="settings">
      <section aria-labelledby="about-heading" data-testid="about">
        <h2 id="about-heading">About</h2>
        <dl className="facts">
          <div>
            <dt>Product</dt>
            <dd data-testid="product-version">
              {report.product} {report.version}
            </dd>
          </div>
          <div>
            <dt>Result contract version</dt>
            <dd>{report.contract_version}</dd>
          </div>
          <div>
            <dt>Engine</dt>
            <dd>{report.engine.engine}</dd>
          </div>
          <div>
            <dt>Data directory</dt>
            <dd data-testid="data-dir">{report.data_dir}</dd>
          </div>
        </dl>
        <p data-testid="data-dir-note">
          Read-only: there is no control on this screen that moves or renames the data
          directory.
        </p>
        <p data-testid="attribution">{report.attribution}</p>
      </section>

      <section aria-labelledby="notices-heading" data-testid="notices">
        <h2 id="notices-heading">Notices</h2>
        <p>These notices are bundled with the app; reading them makes no network request.</p>
        {NOTICES.map((notice) => (
          <div key={notice.id} data-testid={`notice-${notice.id}`}>
            <h3>{notice.title}</h3>
            <ul>
              {notice.body.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section aria-labelledby="history-heading" data-testid="history-section">
        <h2 id="history-heading">History</h2>
        <p data-testid="history-state">{historyEnabled ? "History: On" : "History: Off"}</p>
        {historyEnabled === false ? (
          <p data-testid="history-off-default">
            History is off by default. If you turn it on, OpenReflex stores:{" "}
            {report.history.what_is_stored}
          </p>
        ) : (
          <p data-testid="history-on-stored">
            OpenReflex is storing: {report.history.what_is_stored}
          </p>
        )}
        <div className="actions">
          {historyEnabled === false && (
            <button
              type="button"
              data-testid="enable-history"
              disabled={busy !== null}
              onClick={() => {
                setConfirmText("");
                setConfirmation({ kind: "enable-history" });
              }}
            >
              Enable history
            </button>
          )}
          {historyEnabled === true && (
            <>
              <button
                type="button"
                data-testid="disable-history"
                disabled={busy !== null}
                onClick={() => void setHistory(false)}
              >
                Turn off history
              </button>
              <button
                type="button"
                data-testid="clear-history"
                disabled={busy !== null}
                onClick={() => {
                  setConfirmText("");
                  setConfirmation({ kind: "clear-history" });
                }}
              >
                Clear history
              </button>
            </>
          )}
        </div>
      </section>

      <section aria-labelledby="models-heading" data-testid="models-section">
        <h2 id="models-heading">Models</h2>
        <p data-testid="removal-explanation">
          Removing a model only deletes its local files. It does not uninstall OpenReflex,
          and it does not touch your recipes, history, or settings.
        </p>
        <ul className="profiles">
          {report.models.map((model) => (
            <ModelRow
              key={model.profile}
              model={model}
              busy={busy !== null}
              onRemove={() => {
                setConfirmText("");
                setConfirmation({ kind: "remove-model", profile: model.profile });
              }}
            />
          ))}
        </ul>
      </section>

      {actionError !== null && (
        <p className="error" role="alert" data-testid="action-error">
          {actionError}
        </p>
      )}

      <DiagnosticsPanel report={report} offlineReady={offlineReady} />

      {confirmation !== null && (
        <ConfirmDialog
          confirmation={confirmation}
          whatIsStored={report.history.what_is_stored}
          text={confirmText}
          onText={setConfirmText}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            const current = confirmation;
            setConfirmation(null);
            if (current.kind === "enable-history") {
              void setHistory(true);
            } else if (current.kind === "clear-history") {
              void clearHistory();
            } else {
              void removeModel(current.profile);
            }
          }}
        />
      )}
    </div>
  );
}

function ModelRow({
  model,
  busy,
  onRemove,
}: {
  model: ModelStatus;
  busy: boolean;
  onRemove: () => void;
}) {
  // A removal only makes sense when there are local files to delete:
  // installed, damaged, or an interrupted download. A model that is
  // actively being downloaded is never offered a removal (the service
  // would reject it as busy).
  const removable =
    model.state !== "downloading" &&
    (model.state === "installed" || model.state === "damaged" || model.disk_bytes > 0);
  return (
    <li className="profile-card" data-testid={`model-${model.profile}`}>
      <div className="profile-head">
        <h3>{model.profile}</h3>
        <p className="state" data-testid={`model-state-${model.profile}`}>
          {stateLabel(model)}
        </p>
      </div>
      <dl className="facts">
        <div>
          <dt>Revision</dt>
          <dd data-testid={`model-revision-${model.profile}`}>{model.revision}</dd>
        </div>
        <div>
          <dt>Disk usage</dt>
          <dd data-testid={`model-disk-${model.profile}`}>{humanBytes(model.disk_bytes)}</dd>
        </div>
        <div>
          <dt>Verification</dt>
          <dd data-testid={`model-verified-${model.profile}`}>{verificationLabel(model)}</dd>
        </div>
      </dl>
      {model.last_error !== null && model.state !== "downloading" && (
        <p className="error" role="alert" data-testid={`model-error-${model.profile}`}>
          Last error: {model.last_error}
        </p>
      )}
      <div className="actions">
        {removable && (
          <button
            type="button"
            data-testid={`remove-${model.profile}`}
            disabled={busy}
            onClick={onRemove}
          >
            Remove
          </button>
        )}
        {model.state === "downloading" && <span>Download in progress&hellip;</span>}
      </div>
    </li>
  );
}

function verificationLabel(model: ModelStatus): string {
  if (model.state === "damaged") {
    return "Verification failed";
  }
  if (model.state === "downloading") {
    return "In progress";
  }
  if (model.state === "installed" && model.verified_at !== null) {
    return `Verified ${model.verified_at}`;
  }
  return "Never verified";
}

function ConfirmDialog({
  confirmation,
  whatIsStored,
  text,
  onText,
  onCancel,
  onConfirm,
}: {
  confirmation: Confirmation;
  whatIsStored: string;
  text: string;
  onText: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // The confirmation is explicit and distinct per action: the exact
  // profile name for a removal, the word "enable" for turning history
  // on, the word "clear" for clearing it.
  const requiredText =
    confirmation.kind === "remove-model"
      ? confirmation.profile
      : confirmation.kind === "enable-history"
        ? "enable"
        : "clear";
  const title =
    confirmation.kind === "remove-model"
      ? `Remove the ${confirmation.profile} model?`
      : confirmation.kind === "enable-history"
        ? "Enable history?"
        : "Clear history?";
  const detail =
    confirmation.kind === "enable-history"
      ? `If you turn it on, OpenReflex stores: ${whatIsStored}`
      : confirmation.kind === "clear-history"
        ? "This deletes every stored history entry. This cannot be undone."
        : "This deletes the model's local files. You can download it again later.";
  const confirmLabel =
    confirmation.kind === "remove-model"
      ? "Remove model"
      : confirmation.kind === "enable-history"
        ? "Enable history"
        : "Clear history";
  return (
    <div
      className="dialog"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      data-testid="confirm-dialog"
    >
      <h2>{title}</h2>
      <p data-testid="confirm-detail">{detail}</p>
      <label>
        Type <code>{requiredText}</code> to confirm:
        <input
          data-testid="confirm-input"
          value={text}
          autoComplete="off"
          onChange={(event) => onText(event.target.value)}
        />
      </label>
      <div className="actions">
        <button type="button" data-testid="confirm-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          data-testid="confirm-submit"
          disabled={text !== requiredText}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
