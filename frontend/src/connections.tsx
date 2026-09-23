/**
 * Connections screen: safe, copyable MCP setup and removal guidance for
 * every V1 client (Claude Code, OpenCode, VS Code / GitHub Copilot).
 *
 * Every piece of guidance comes from the authenticated, read-only
 * ``GET /v1/connections`` response: the privacy note, the configuration
 * policy, and each client's generated configuration plus its setup,
 * verification, restart, and removal steps. Every client gets a
 * dedicated verification section, server-owned, so the user can check
 * that the connection works after merging and restarting. The screen
 * never reconstructs a client
 * configuration itself - it renders the exact ``config`` object the
 * service generated - and it never writes a client configuration file,
 * launches a client, or sends the generated configuration anywhere: the
 * only action is copying the snippet into the local clipboard on an
 * explicit click, with explicit success or failure feedback. The screen
 * never reads the clipboard, and the sign-in token never reaches the
 * rendered content.
 *
 * An unreadable payload (a missing or malformed client list, or a client
 * without a non-empty configuration object) is surfaced as a load error
 * or a per-client error with a retry, never rendered as an empty
 * snippet.
 */

import { useCallback, useEffect, useState } from "react";
import { ApiError, CanceledError, request } from "./api";
import type { ClientConnection, ConnectionListing } from "./connectionsModel";

type CopyState = "idle" | "copied" | "failed";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0
  );
}

function isReadableListing(value: ConnectionListing): boolean {
  return (
    Array.isArray(value.clients) &&
    value.clients.every(
      (client) =>
        typeof client.client === "string" &&
        typeof client.name === "string" &&
        isStringArray(client.setup) &&
        isStringArray(client.verification) &&
        isStringArray(client.restart) &&
        isStringArray(client.removal) &&
        typeof client.schema_source === "string" &&
        typeof client.schema_verified === "string",
    )
  );
}

export function ConnectionsScreen() {
  const [listing, setListing] = useState<ConnectionListing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // One read-only request on load (and on an explicit retry). Nothing on
  // this screen is ever sent to the service: the only interaction is
  // copying text into the local clipboard.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const next = await request<ConnectionListing>("GET", "/v1/connections", undefined, {
          signal: controller.signal,
        });
        if (!isReadableListing(next)) {
          throw new ApiError(
            0,
            "invalid_connections",
            "the service returned an unreadable connections listing",
            null,
            [],
          );
        }
        setLoadError(null);
        setListing(next);
      } catch (error) {
        if (error instanceof CanceledError) {
          return;
        }
        setListing(null);
        setLoadError(
          error instanceof ApiError ? error.message : "could not reach the local service",
        );
      }
    })();
    return () => controller.abort();
  }, [reloadKey]);

  if (loadError !== null) {
    return (
      <div role="alert" data-testid="connections-error">
        <p>Could not load the connection setup: {loadError}</p>
        <button
          type="button"
          data-testid="connections-retry"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          Try again
        </button>
      </div>
    );
  }
  if (listing === null) {
    return <p data-testid="connections-loading">Loading the connection setup&hellip;</p>;
  }

  return (
    <div data-testid="connections">
      {/* The privacy/locality explanation comes before any setup step:
          OpenReflex inference is local, but an external AI client may
          process the content sent through it under its own terms. */}
      <section aria-labelledby="privacy-heading" data-testid="privacy-section">
        <h2 id="privacy-heading">Local inference, external clients</h2>
        <p data-testid="privacy-note">{listing.privacy_note}</p>
        <p data-testid="configuration-policy">{listing.configuration_policy}</p>
        <p data-testid="merge-guidance">
          Merge only the &ldquo;openreflex&rdquo; entry into your existing configuration.
          Keep every other MCP server and every other setting exactly as they are -
          replace nothing. The steps below only ever touch the &ldquo;openreflex&rdquo;
          entry.
        </p>
      </section>

      {listing.clients.map((client) => (
        <ClientCard key={client.client} client={client} />
      ))}
    </div>
  );
}

function ClientCard({ client }: { client: ClientConnection }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const hasConfig = isConfigObject(client.config);
  // The exact object the service generated, serialized for display and
  // copy. No frontend reconstruction: keys, values, and order are the
  // server's, and path escaping (spaces, quotes, backslashes,
  // non-ASCII) is preserved by the JSON serialization.
  const snippet = hasConfig ? JSON.stringify(client.config, null, 2) : null;

  const copy = useCallback(async () => {
    if (snippet === null) {
      return;
    }
    try {
      // Write-only: the clipboard is never read back.
      await navigator.clipboard.writeText(snippet);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }, [snippet]);

  return (
    <section
      aria-labelledby={`${client.client}-heading`}
      className="client-card"
      data-testid={`client-${client.client}`}
    >
      <h2 id={`${client.client}-heading`}>{client.name}</h2>

      <h3>Setup</h3>
      <ol className="steps" data-testid={`setup-steps-${client.client}`}>
        {client.setup.map((step, index) => (
          <li key={`${index}-${step}`}>{step}</li>
        ))}
      </ol>

      {hasConfig && snippet !== null ? (
        <>
          <h3>Configuration to merge</h3>
          <pre className="snippet" data-testid={`config-${client.client}`}>
            {snippet}
          </pre>
          <div className="actions">
            <button
              type="button"
              data-testid={`copy-${client.client}`}
              onClick={() => void copy()}
            >
              Copy configuration
            </button>
          </div>
          <p aria-live="polite" data-testid={`copy-status-${client.client}`}>
            {copyState === "copied" ? "Copied to the clipboard." : ""}
          </p>
          {copyState === "failed" && (
            <p className="error" role="alert" data-testid={`copy-error-${client.client}`}>
              Copy failed; the configuration is shown above for manual copying.
            </p>
          )}
        </>
      ) : (
        <p className="error" role="alert" data-testid={`config-missing-${client.client}`}>
          The service did not return a configuration for {client.name}.
        </p>
      )}

      <h3>Restart</h3>
      <ol className="steps" data-testid={`restart-steps-${client.client}`}>
        {client.restart.map((step, index) => (
          <li key={`${index}-${step}`}>{step}</li>
        ))}
      </ol>

      {/* Verification is server-owned per client: check the connection
          after the merge and the restart. */}
      <h3>Verification</h3>
      <ol className="steps" data-testid={`verification-steps-${client.client}`}>
        {client.verification.map((step, index) => (
          <li key={`${index}-${step}`}>{step}</li>
        ))}
      </ol>

      <h3>Removal</h3>
      <ol className="steps" data-testid={`removal-steps-${client.client}`}>
        {client.removal.map((step, index) => (
          <li key={`${index}-${step}`}>{step}</li>
        ))}
      </ol>

      <dl className="facts">
        <div>
          <dt>Authoritative source</dt>
          <dd data-testid={`schema-source-${client.client}`}>{client.schema_source}</dd>
        </div>
        <div>
          <dt>Shape verified</dt>
          <dd data-testid={`schema-verified-${client.client}`}>{client.schema_verified}</dd>
        </div>
      </dl>
    </section>
  );
}
