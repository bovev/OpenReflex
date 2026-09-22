/**
 * Safe diagnostics formatting.
 *
 * The diagnostics text is built from an explicit allowlist of fields of the
 * ``/v1/status`` payload. The builder never copies the payload wholesale
 * (no object spread, no serialization of the input), so fields that are not
 * named here cannot reach the diagnostics: the sign-in token (which the API
 * never returns), recipes, decision inputs and outputs, history entries,
 * request bodies, home-directory details (``data_dir`` is replaced with a
 * fixed label), and raw exception text. ``last_error`` is included because
 * the API's error messages are product-owned and documented as safe to show
 * and log.
 *
 * The offline-ready value is supplied by the caller, derived from the
 * current model snapshot (the same value the screen shows). The payload's
 * own ``offline_ready`` flag is deliberately not used: it is only as fresh
 * as the last ``/v1/status`` read and would go stale while the screen
 * polls ``/v1/models``, so the screen and the diagnostics can never
 * disagree after a model state change.
 *
 * The rendering is deterministic: the same payload and readiness always
 * produce the same text, with no timestamps, locale formatting, or
 * machine-specific paths.
 */

import { humanBytes, type StatusReport } from "./types";

/** Fixed label that replaces the real data directory path. */
export const DATA_DIR_LABEL = "the user's OpenReflex data directory on this machine";

/** What the diagnostics deliberately never contain. */
export const DIAGNOSTICS_EXCLUDES = [
  "the sign-in token",
  "recipes",
  "decision inputs and outputs",
  "history entries",
  "request bodies",
  "home-directory details",
  "raw exception text",
] as const;

export interface DiagnosticsProduct {
  readonly name: string;
  readonly version: string;
  readonly contract_version: number;
  readonly attribution: string;
}

export interface DiagnosticsService {
  readonly offline_ready: boolean;
  readonly default_profile: string;
  readonly queue_depth: number;
  readonly queue_capacity: number;
}

export interface DiagnosticsEngine {
  readonly engine: string;
  readonly loaded_profile: string | null;
  readonly loaded_checkpoint: string | null;
}

export interface DiagnosticsHistory {
  readonly enabled: boolean;
  readonly what_is_stored: string;
}

export interface DiagnosticsProgress {
  readonly done_bytes: number;
  readonly total_bytes: number;
  readonly current_file: string | null;
}

export interface DiagnosticsModel {
  readonly profile: string;
  readonly state: string;
  readonly checkpoint: string;
  readonly revision: string;
  readonly download_bytes: number;
  readonly disk_bytes: number;
  readonly verified_at: string | null;
  readonly progress: DiagnosticsProgress | null;
  readonly last_error: string | null;
}

export interface Diagnostics {
  readonly product: DiagnosticsProduct;
  readonly service: DiagnosticsService;
  readonly engine: DiagnosticsEngine;
  readonly history: DiagnosticsHistory;
  readonly data_dir: string;
  readonly models: DiagnosticsModel[];
}

/**
 * Copy the allowlisted fields of a status report into the diagnostics
 * structure. Every value passes through this explicit mapping, so anything
 * else on the payload (or on the wire) is dropped. ``offlineReady`` is the
 * readiness derived from the current model snapshot by the caller.
 */
export function buildDiagnostics(status: StatusReport, offlineReady: boolean): Diagnostics {
  return {
    product: {
      name: status.product,
      version: status.version,
      contract_version: status.contract_version,
      attribution: status.attribution,
    },
    service: {
      offline_ready: offlineReady,
      default_profile: status.default_profile,
      queue_depth: status.queue_depth,
      queue_capacity: status.queue_capacity,
    },
    engine: {
      engine: status.engine.engine,
      loaded_profile: status.engine.loaded_profile,
      loaded_checkpoint: status.engine.loaded_checkpoint,
    },
    history: {
      enabled: status.history.enabled,
      what_is_stored: status.history.what_is_stored,
    },
    data_dir: DATA_DIR_LABEL,
    models: status.models.map((model) => ({
      profile: model.profile,
      state: model.state,
      checkpoint: model.checkpoint,
      revision: model.revision,
      download_bytes: model.download_bytes,
      disk_bytes: model.disk_bytes,
      verified_at: model.verified_at,
      progress:
        model.progress === null
          ? null
          : {
              done_bytes: model.progress.done_bytes,
              total_bytes: model.progress.total_bytes,
              current_file: model.progress.current_file,
            },
      last_error: model.last_error,
    })),
  };
}

const bool = (value: boolean): string => (value ? "yes" : "no");

/** Render the diagnostics as plain text. Deterministic for a given payload. */
export function renderDiagnostics(d: Diagnostics): string {
  const lines: string[] = [];
  lines.push("OpenReflex diagnostics");
  lines.push("=====================");
  lines.push("");
  lines.push("Product");
  lines.push("-------");
  lines.push(`name: ${d.product.name}`);
  lines.push(`version: ${d.product.version}`);
  lines.push(`result contract version: ${d.product.contract_version}`);
  lines.push(`attribution: ${d.product.attribution}`);
  lines.push("");
  lines.push("Service");
  lines.push("-------");
  lines.push(`offline ready: ${bool(d.service.offline_ready)}`);
  lines.push(`default profile: ${d.service.default_profile}`);
  lines.push(
    `inference queue: ${d.service.queue_depth} of ${d.service.queue_capacity}`,
  );
  lines.push(
    `history: ${bool(d.history.enabled) === "yes" ? "enabled" : "disabled"} - ${d.history.what_is_stored}`,
  );
  lines.push("");
  lines.push("Engine");
  lines.push("------");
  lines.push(`engine: ${d.engine.engine}`);
  lines.push(`loaded profile: ${d.engine.loaded_profile ?? "none"}`);
  lines.push(`loaded checkpoint: ${d.engine.loaded_checkpoint ?? "none"}`);
  lines.push("");
  lines.push("Data location");
  lines.push("-------------");
  lines.push(`data directory: ${d.data_dir}`);
  lines.push("");
  lines.push("Models");
  lines.push("------");
  for (const model of d.models) {
    lines.push(`${model.profile}: ${model.state}`);
    lines.push(`  checkpoint: ${model.checkpoint}`);
    lines.push(`  revision: ${model.revision}`);
    lines.push(
      `  download size: ${humanBytes(model.download_bytes)} (${model.download_bytes} bytes)`,
    );
    lines.push(
      `  disk usage: ${humanBytes(model.disk_bytes)} (${model.disk_bytes} bytes)`,
    );
    lines.push(`  verified at: ${model.verified_at ?? "never"}`);
    if (model.progress !== null) {
      lines.push(
        `  progress: ${model.progress.done_bytes} of ${model.progress.total_bytes} bytes` +
          (model.progress.current_file !== null
            ? `, current file: ${model.progress.current_file}`
            : ""),
      );
    }
    lines.push(`  last error: ${model.last_error ?? "none"}`);
  }
  lines.push("");
  return lines.join("\n");
}
