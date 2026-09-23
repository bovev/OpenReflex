/**
 * Bundled project and third-party notices.
 *
 * These are static text bundled with the app: reading them never issues
 * a network request, so the notices and the Laya attribution stay
 * available offline. The wording mirrors ``THIRD_PARTY_NOTICES.md`` and
 * the project license. The live attribution line rendered on the
 * Settings screen comes from the service's ``/v1/status`` payload
 * (``attribution``), not from here, so the server-owned wording always
 * wins.
 */

export interface Notice {
  readonly id: string;
  readonly title: string;
  readonly body: readonly string[];
}

export const PROJECT_NOTICE: Notice = {
  id: "project",
  title: "OpenReflex",
  body: [
    "OpenReflex is licensed under Apache-2.0 (full text in the bundled LICENSE file).",
    "The service listens only on 127.0.0.1, stores everything in the local data directory, and collects no telemetry.",
    "History is off by default and stays off until you explicitly turn it on.",
    "Model weights are never bundled; a download starts only on your explicit request.",
  ],
};

export const LAYA_NOTICE: Notice = {
  id: "laya",
  title: "Laya",
  body: [
    "Laya - an open-source System 1 decision model, developed by Convai Innovations.",
    "License: Apache-2.0 (package metadata and repository LICENSE).",
    "Relationship: runtime dependency, used only through openreflex.laya_adapter. No Laya source is copied into this repository.",
    "Model checkpoints: declared license apache-2.0 (Hugging Face model card metadata).",
  ],
};

export const DEPENDENCIES_NOTICE: Notice = {
  id: "dependencies",
  title: "Other dependencies",
  body: [
    "A full inventory of Python, JavaScript, installer, and native binary dependencies is produced during release hardening. Status: pending.",
  ],
};

export const NOTICES: readonly Notice[] = [PROJECT_NOTICE, LAYA_NOTICE, DEPENDENCIES_NOTICE];
