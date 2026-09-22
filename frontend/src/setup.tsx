/**
 * Setup screen: service readiness, model state, explicitly consented
 * downloads, progress, failure and recovery, and safe diagnostics.
 *
 * A download starts only from an explicit button click
 * (``POST /v1/models/<profile>/download``). On load and while polling, only
 * ``GET /v1/status`` and ``GET /v1/models`` are issued, so reloading the
 * page during a download resumes observation of the server-side download
 * instead of starting a second one. Every model operation goes through the
 * authenticated same-origin ``/v1`` API client.
 *
 * Status is always carried by text (and an announced progress indicator),
 * never by color alone.
 *
 * Offline readiness is derived once from the current model snapshot and
 * used everywhere it is shown - the Setup summary and the diagnostics -
 * so the two cannot disagree after a model state change. A failed status
 * poll is surfaced as a temporary service unreachability: the last known
 * model state is kept, observation continues on the same interval, and
 * the next successful poll restores the reachable state without starting
 * another download.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, CanceledError, request } from "./api";
import {
  buildDiagnostics,
  DIAGNOSTICS_EXCLUDES,
  renderDiagnostics,
} from "./diagnostics";
import {
  humanBytes,
  type DownloadableProfile,
  type ModelProfile,
  type ModelStatus,
  type StatusReport,
} from "./types";

export const POLL_INTERVAL_MS = 1000;
export const DIAGNOSTICS_FILENAME = "openreflex-diagnostics.txt";

const DOWNLOADABLE_PROFILES: readonly DownloadableProfile[] = [
  "typed-decisions",
  "english",
  "multilingual",
];

/**
 * Static profile presentation. ``auto`` is not a checkpoint: the service
 * routes between ``english`` and ``multilingual``, so both must be
 * installed. Limitations are the documented ones (docs/model-limitations.md
 * and the plan's profile table), stated factually, without accuracy claims.
 */
const PROFILE_INFO: Record<
  ModelProfile,
  { tier: "Recommended" | "Advanced" | "Experimental"; note: string }
> = {
  "typed-decisions": {
    tier: "Recommended",
    note: "The default profile for decision recipes.",
  },
  english: {
    tier: "Advanced",
    note: "Advanced. English-language checkpoint with a shorter context window (512 tokens).",
  },
  multilingual: {
    tier: "Advanced",
    note:
      "Advanced. Multilingual checkpoint. Calibration warning: shipped confidence can be over-confident without domain calibration; calibrate thresholds on your own labelled examples before relying on them.",
  },
  auto: {
    tier: "Experimental",
    note:
      "Experimental. Not a checkpoint of its own: it routes decisions between the english and multilingual checkpoints, so both must be installed.",
  },
};

function mergeModel(models: readonly ModelStatus[], updated: ModelStatus): ModelStatus[] {
  const present = models.some((m) => m.profile === updated.profile);
  const next = models.map((m) => (m.profile === updated.profile ? updated : m));
  return present ? next : [...next, updated];
}

/**
 * A profile's download has reached a terminal state: verified and
 * installed, damaged, or failed (a recorded error with no in-flight
 * progress). A plain ``not_installed`` without an error is not terminal:
 * the backend's 202 response can race the background thread and report
 * exactly that.
 */
function isTerminalState(model: ModelStatus): boolean {
  return (
    model.state === "installed" ||
    model.state === "damaged" ||
    (model.state === "not_installed" && model.last_error !== null)
  );
}

function stateLabel(model: ModelStatus): string {
  switch (model.state) {
    case "installed":
      return "Installed";
    case "downloading":
      return "Downloading";
    case "damaged":
      return "Damaged (verification failed)";
    case "not_installed":
      return model.disk_bytes > 0 ? "Interrupted download" : "Not installed";
  }
}

function phaseText(model: ModelStatus): string {
  if (model.state === "downloading") {
    if (model.progress === null) {
      return "starting";
    }
    const { done_bytes, total_bytes, current_file } = model.progress;
    const percent =
      total_bytes > 0 ? Math.min(100, Math.floor((done_bytes / total_bytes) * 100)) : 0;
    const file = current_file !== null ? `, ${current_file}` : "";
    return `${percent}% (${humanBytes(done_bytes)} of ${humanBytes(total_bytes)}${file})`;
  }
  if (model.state === "installed") {
    return "complete and verified";
  }
  if (model.state === "damaged") {
    return "verification failed; not usable";
  }
  return model.disk_bytes > 0
    ? `interrupted; ${humanBytes(model.disk_bytes)} already downloaded, and a new download resumes from there`
    : "not installed";
}

type BusyAction = { kind: "download" | "verify"; profile: DownloadableProfile };

export function SetupScreen() {
  const [report, setReport] = useState<StatusReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const models: ModelStatus[] = report?.models ?? [];
  const anyDownloading = models.some((m) => m.state === "downloading");
  // Profiles with an accepted download request that has not reached a
  // terminal state yet. The backend's 202 response can race the
  // background thread and still report ``not_installed``, so observation
  // starts after every accepted request, not only on a ``downloading``
  // response.
  const [watching, setWatching] = useState<DownloadableProfile[]>([]);
  // A failed status poll: the last known model state is kept, the warning
  // is shown, observation continues, and the next successful poll clears
  // it again.
  const [pollFailure, setPollFailure] = useState(false);
  // At most one status poll may be in flight at a time. Without this
  // guard a slow poll can overlap the next tick: an older poll could still
  // be pending when a newer poll returns a terminal state and stops the
  // interval, after which the older poll fails and leaves the screen
  // "Temporarily unreachable" with no polling left to recover it.
  // Each polling effect run also owns an ``AbortController``: when the
  // run is cleaned up (a new download changed ``watching``), its
  // in-flight poll is invalidated - its handlers check the signal and
  // bail, so a stale snapshot can neither clobber the current state nor
  // touch the flight guard.
  const pollInFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const next = await request<StatusReport>("GET", "/v1/status", undefined, {
          signal: controller.signal,
        });
        if (!Array.isArray(next.models)) {
          throw new ApiError(0, "invalid_status", "the service returned an unreadable status", null, []);
        }
        setLoadError(null);
        setReport(next);
      } catch (error) {
        if (error instanceof CanceledError) {
          return;
        }
        setReport(null);
        setLoadError(
          error instanceof ApiError ? error.message : "could not reach the local service",
        );
      }
    })();
    return () => controller.abort();
  }, [reloadKey]);

  // Observe in-flight downloads. This runs on load as well, which is how a
  // page reload during a download resumes observation without starting a
  // second download: only GET /v1/models is issued here. It also runs for
  // profiles we started downloading (``watching``), because the 202
  // response can race the backend's background thread and still report
  // ``not_installed``; observation continues until a terminal state.
  useEffect(() => {
    if (!anyDownloading && watching.length === 0) {
      return;
    }
    const controller = new AbortController();
    const id = setInterval(() => {
      // Serialize: if a poll is already in flight, skip this tick so that
      // completions can never overlap and race each other.
      if (pollInFlight.current) {
        return;
      }
      pollInFlight.current = true;
      request<ModelStatus[]>("GET", "/v1/models", undefined, {
        signal: controller.signal,
      })
        .then(
          (next) => {
            // This effect run was cleaned up while the poll was in flight
            // (e.g. a new download changed ``watching``): the snapshot is
            // obsolete and must not clobber the current state or stop the
            // observation a newer run continues.
            if (controller.signal.aborted) {
              return;
            }
            if (Array.isArray(next)) {
              setReport((prev) => (prev === null ? prev : { ...prev, models: next }));
              setPollFailure(false);
              setWatching((current) => {
                const remaining = current.filter((profile) => {
                  const model = next.find((m) => m.profile === profile);
                  return model === undefined || !isTerminalState(model);
                });
                return remaining.length === current.length ? current : remaining;
              });
            }
          },
          (error) => {
            if (controller.signal.aborted || error instanceof CanceledError) {
              return;
            }
            // Keep the last known model state; observation continues on the
            // same interval, and the next successful poll clears the
            // warning again.
            setPollFailure(true);
          },
        )
        .finally(() => {
          // A cleaned-up run's poll must not touch the flight guard: the
          // cleanup below already reset it, and resetting it here could
          // clear a newer run's in-flight poll.
          if (!controller.signal.aborted) {
            pollInFlight.current = false;
          }
        });
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(id);
      // Invalidate this run's in-flight poll (if any) and reset the
      // flight guard before the next run's first tick, so serialization
      // can never strand.
      pollInFlight.current = false;
      controller.abort();
    };
  }, [anyDownloading, watching]);

  const startDownload = useCallback(async (profile: DownloadableProfile) => {
    setActionError(null);
    setBusy({ kind: "download", profile });
    try {
      const next = await request<ModelStatus>("POST", `/v1/models/${profile}/download`);
      setReport((prev) =>
        prev === null ? prev : { ...prev, models: mergeModel(prev.models, next) },
      );
      // Accepted means the service will run the download; observe it even
      // when this immediate status read still reports ``not_installed``.
      setWatching((current) => (current.includes(profile) ? current : [...current, profile]));
    } catch (error) {
      if (error instanceof CanceledError) {
        return;
      }
      setActionError(
        error instanceof ApiError ? error.message : "could not start the download",
      );
    } finally {
      setBusy(null);
    }
  }, []);

  const verifyModel = useCallback(async (profile: DownloadableProfile) => {
    setActionError(null);
    setBusy({ kind: "verify", profile });
    try {
      const next = await request<ModelStatus>("POST", `/v1/models/${profile}/verify`);
      setReport((prev) =>
        prev === null ? prev : { ...prev, models: mergeModel(prev.models, next) },
      );
    } catch (error) {
      if (error instanceof CanceledError) {
        return;
      }
      setActionError(
        error instanceof ApiError ? error.message : "could not verify the model",
      );
    } finally {
      setBusy(null);
    }
  }, []);

  if (loadError !== null) {
    return (
      <div role="alert" data-testid="setup-error">
        <p>Could not load the service status: {loadError}</p>
        <button
          type="button"
          data-testid="setup-retry"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          Try again
        </button>
      </div>
    );
  }
  if (report === null) {
    return <p data-testid="setup-loading">Loading the service status&hellip;</p>;
  }

  const liveSummary = models
    .map((m) => `${m.profile}: ${stateLabel(m)}, ${phaseText(m)}`)
    .join("; ");
  const offlineReady = deriveOfflineReady(report.default_profile, models);

  return (
    <div data-testid="setup">
      <section aria-labelledby="service-status-heading" data-testid="service-status">
        <h2 id="service-status-heading">Service</h2>
        <dl className="facts">
          <div>
            <dt>Service state</dt>
            <dd data-testid="service-reachability">
              {pollFailure
                ? "Temporarily unreachable - a status poll failed; the last known state is shown, and observation continues."
                : "Reachable - the status loaded successfully."}
            </dd>
          </div>
          <div>
            <dt>Product</dt>
            <dd>
              {report.product} {report.version}
            </dd>
          </div>
          <div>
            <dt>Offline ready</dt>
            <dd data-testid="offline-ready">
              {offlineReady
                ? "Yes - the default model is installed and verified."
                : "No - the default model is not installed yet."}
            </dd>
          </div>
          <div>
            <dt>Default profile</dt>
            <dd>{report.default_profile}</dd>
          </div>
          <div>
            <dt>Engine</dt>
            <dd>
              {report.engine.engine}
              {report.engine.loaded_profile !== null
                ? ` (loaded: ${report.engine.loaded_profile})`
                : " (no model loaded)"}
            </dd>
          </div>
          <div>
            <dt>Inference queue</dt>
            <dd>
              {report.queue_depth} of {report.queue_capacity}
            </dd>
          </div>
          <div>
            <dt>History</dt>
            <dd>
              {report.history.enabled ? "Enabled" : "Disabled"} - {report.history.what_is_stored}
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="models-heading">
        <h2 id="models-heading">Models</h2>
        <ul className="profiles">
          {DOWNLOADABLE_PROFILES.map((profile) => {
            const model = models.find((m) => m.profile === profile);
            if (model === undefined) {
              return null;
            }
            return (
              <ProfileCard
                key={profile}
                model={model}
                busy={busy !== null && busy.profile === profile}
                onDownload={() => startDownload(profile)}
                onVerify={() => verifyModel(profile)}
              />
            );
          })}
          <li className="profile-card" data-testid="profile-auto">
            <div className="profile-head">
              <h3>
                auto <span className="tier">{PROFILE_INFO.auto.tier}</span>
              </h3>
              <p className="state" data-testid="state-auto">
                {autoStateText(models)}
              </p>
            </div>
            <p className="note">{PROFILE_INFO.auto.note}</p>
            <p className="state-detail" data-testid="auto-detail">
              {autoDetailText(models)}
            </p>
          </li>
        </ul>
      </section>

      {actionError !== null && (
        <p className="error" role="alert" data-testid="action-error">
          {actionError}
        </p>
      )}

      <DiagnosticsPanel report={report} offlineReady={offlineReady} />

      <p className="visually-hidden" aria-live="polite" data-testid="status-live">
        {liveSummary}
      </p>
    </div>
  );
}

function autoStateText(models: ModelStatus[]): string {
  const missing = missingCandidates(models);
  return missing.length === 0
    ? "Ready (routes between english and multilingual)"
    : `Not ready (missing: ${missing.join(", ")})`;
}

function autoDetailText(models: ModelStatus[]): string {
  const missing = missingCandidates(models);
  return missing.length === 0
    ? "Both candidate checkpoints are installed and verified."
    : `Install and verify: ${missing.join(" and ")}. There is nothing to download for auto itself.`;
}

function missingCandidates(models: ModelStatus[]): string[] {
  const missing: string[] = [];
  for (const profile of ["english", "multilingual"] as const) {
    const model = models.find((m) => m.profile === profile);
    if (model === undefined || model.state !== "installed") {
      missing.push(profile);
    }
  }
  return missing;
}

/**
 * Offline readiness, the same definition the service uses
 * (``is_ready(default_profile)``), derived from the current model
 * snapshot. This one value drives every place readiness is shown - the
 * Setup summary and the diagnostics - so the two cannot disagree: the
 * status report's own ``offline_ready`` flag is only as fresh as the
 * initial ``/v1/status`` read and is not used.
 */
function deriveOfflineReady(defaultProfile: ModelProfile, models: ModelStatus[]): boolean {
  if (defaultProfile === "auto") {
    return missingCandidates(models).length === 0;
  }
  const model = models.find((m) => m.profile === defaultProfile);
  return model !== undefined && model.state === "installed";
}

function ProfileCard({
  model,
  busy,
  onDownload,
  onVerify,
}: {
  model: ModelStatus;
  busy: boolean;
  onDownload: () => void;
  onVerify: () => void;
}) {
  const info = PROFILE_INFO[model.profile];
  const progress = model.state === "downloading" ? model.progress : null;
  const percent =
    progress !== null && progress.total_bytes > 0
      ? Math.min(100, Math.floor((progress.done_bytes / progress.total_bytes) * 100))
      : 0;
  return (
    <li className="profile-card" data-testid={`profile-${model.profile}`}>
      <div className="profile-head">
        <h3>
          {model.profile} <span className="tier">{info.tier}</span>
        </h3>
        <p className="state" data-testid={`state-${model.profile}`}>
          {stateLabel(model)}
        </p>
      </div>
      <p className="note">{info.note}</p>
      <dl className="facts">
        <div>
          <dt>Revision</dt>
          <dd>{model.revision}</dd>
        </div>
        <div>
          <dt>Download size</dt>
          <dd data-testid={`size-${model.profile}`}>{humanBytes(model.download_bytes)}</dd>
        </div>
        <div>
          <dt>Disk usage</dt>
          <dd>{humanBytes(model.disk_bytes)}</dd>
        </div>
        {model.verified_at !== null && (
          <div>
            <dt>Verified</dt>
            <dd data-testid={`verified-${model.profile}`}>{model.verified_at}</dd>
          </div>
        )}
      </dl>
      <p className="state-detail" data-testid={`phase-${model.profile}`}>
        {stateLabel(model)}: {phaseText(model)}
      </p>
      {progress !== null && (
        <div
          className="progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total_bytes}
          aria-valuenow={progress.done_bytes}
          aria-valuetext={`${progress.done_bytes} of ${progress.total_bytes} bytes${
            progress.current_file !== null ? `, ${progress.current_file}` : ""
          }`}
          data-testid={`progressbar-${model.profile}`}
        >
          <div className="progress-bar" style={{ width: `${percent}%` }} />
        </div>
      )}
      {model.state === "not_installed" && (
        <ul className="pre-download" data-testid={`pre-download-${model.profile}`}>
          <li>Downloading needs an internet connection.</li>
          <li>
            Expected download: {humanBytes(model.download_bytes)}; disk usage after install is
            about the same.
          </li>
          <li>Every file is checked against a pinned hash before it counts as installed.</li>
          <li>An interrupted download resumes from where it stopped.</li>
          <li>Once installed and verified, the model runs offline.</li>
        </ul>
      )}
      {model.last_error !== null && model.state !== "downloading" && (
        <p className="error" role="alert" data-testid={`error-${model.profile}`}>
          Last error: {model.last_error}
        </p>
      )}
      <div className="actions">
        {model.state === "not_installed" && (
          <button
            type="button"
            data-testid={`download-${model.profile}`}
            disabled={busy}
            onClick={onDownload}
          >
            {model.disk_bytes > 0 ? "Resume download" : "Download"}
          </button>
        )}
        {model.state === "damaged" && (
          <button
            type="button"
            data-testid={`redownload-${model.profile}`}
            disabled={busy}
            onClick={onDownload}
          >
            Download again
          </button>
        )}
        {model.state === "installed" && (
          <button
            type="button"
            data-testid={`verify-${model.profile}`}
            disabled={busy}
            onClick={onVerify}
          >
            Verify
          </button>
        )}
        {model.state === "downloading" && <span>Download in progress&hellip;</span>}
      </div>
    </li>
  );
}

function DiagnosticsPanel({
  report,
  offlineReady,
}: {
  report: StatusReport;
  offlineReady: boolean;
}) {
  const [shown, setShown] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const text = useMemo(
    () => renderDiagnostics(buildDiagnostics(report, offlineReady)),
    [report, offlineReady],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyError(null);
    } catch {
      setCopyError("copy failed; use the preview or download for the same text");
    }
  };

  const download = () => {
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = DIAGNOSTICS_FILENAME;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <section aria-labelledby="diagnostics-heading" data-testid="diagnostics">
      <h2 id="diagnostics-heading">Diagnostics</h2>
      <p>
        Operational versions and model states only. Never included: {DIAGNOSTICS_EXCLUDES.join(", ")}.
      </p>
      <div className="actions">
        <button
          type="button"
          data-testid="diagnostics-toggle"
          onClick={() => setShown((value) => !value)}
        >
          {shown ? "Hide diagnostics preview" : "Show diagnostics preview"}
        </button>
        <button type="button" data-testid="diagnostics-copy" onClick={() => void copy()}>
          Copy diagnostics
        </button>
        <button type="button" data-testid="diagnostics-download" onClick={download}>
          Download diagnostics
        </button>
      </div>
      {copyError !== null && (
        <p className="error" role="alert" data-testid="diagnostics-copy-error">
          {copyError}
        </p>
      )}
      {shown && (
        <pre className="diagnostics-preview" data-testid="diagnostics-preview">
          {text}
        </pre>
      )}
    </section>
  );
}
