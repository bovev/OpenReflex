/**
 * Typed views of the ``GET /v1/connections`` payload the Connections
 * screen consumes.
 *
 * These mirror the backend's Pydantic models one-to-one. The API client
 * does not validate the wire format, so the screen treats an unreadable
 * payload as a load error rather than rendering it.
 *
 * The ``config`` object is the exact configuration the service's
 * generator produced for the installed executable. The screen renders it
 * as-is (serialized with ``JSON.stringify``) and never reconstructs a
 * client configuration itself.
 */

/** A JSON value in a generated configuration (the service's JsonValue). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface ClientConnection {
  readonly client: string;
  readonly name: string;
  readonly config: Readonly<Record<string, JsonValue>>;
  readonly setup: readonly string[];
  readonly verification: readonly string[];
  readonly restart: readonly string[];
  readonly removal: readonly string[];
  readonly schema_source: string;
  readonly schema_verified: string;
}

export interface ConnectionListing {
  readonly privacy_note: string;
  readonly configuration_policy: string;
  readonly clients: readonly ClientConnection[];
}
