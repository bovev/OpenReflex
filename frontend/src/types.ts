/**
 * Typed views of the ``/v1`` API payloads the Setup screen consumes
 * (``GET /v1/status``, ``GET /v1/models``, and the model actions).
 *
 * These mirror the backend's Pydantic models one-to-one. The API client
 * does not validate the wire format, so the Setup screen treats an
 * unreadable payload as a load error rather than rendering it.
 */

export type ModelProfile = "typed-decisions" | "english" | "multilingual" | "auto";

/** Profiles that have their own checkpoint and can be downloaded directly. */
export type DownloadableProfile = Exclude<ModelProfile, "auto">;

export type ModelState = "not_installed" | "downloading" | "installed" | "damaged";

export interface Progress {
  readonly done_bytes: number;
  readonly total_bytes: number;
  readonly current_file: string | null;
}

export interface ModelStatus {
  readonly profile: ModelProfile;
  readonly checkpoint: string;
  readonly revision: string;
  readonly state: ModelState;
  readonly download_bytes: number;
  readonly disk_bytes: number;
  readonly verified_at: string | null;
  readonly progress: Progress | null;
  readonly last_error: string | null;
}

export interface EngineStatus {
  readonly engine: string;
  readonly loaded_profile: ModelProfile | null;
  readonly loaded_checkpoint: string | null;
}

export interface HistoryStatus {
  readonly enabled: boolean;
  readonly what_is_stored: string;
}

export interface StatusReport {
  readonly product: string;
  readonly version: string;
  readonly contract_version: number;
  readonly attribution: string;
  readonly offline_ready: boolean;
  readonly default_profile: ModelProfile;
  readonly engine: EngineStatus;
  readonly models: ModelStatus[];
  readonly queue_depth: number;
  readonly queue_capacity: number;
  readonly history: HistoryStatus;
  readonly data_dir: string;
}

/**
 * Format a byte count for display, in binary units.
 * Deterministic: no locale dependence, at most one decimal place.
 */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.trunc(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${units[unit]}`;
}
