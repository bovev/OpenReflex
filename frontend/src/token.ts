/**
 * Tab-scoped bearer token handling.
 *
 * ``openreflex-service open`` launches the browser at
 * ``http://127.0.0.1:<port>/#token=<token>``. The fragment is never sent to
 * the server by the browser. We extract it exactly once, remove it from the
 * visible URL with ``history.replaceState``, and keep the token in this
 * module's memory only. It never reaches ``localStorage``, ``sessionStorage``,
 * cookies, query strings, logs, or rendered content, and it is never written
 * anywhere that survives a tab reload.
 */

const TOKEN_KEY = "token";

let tabToken: string | null = null;

/**
 * Extract the token from the URL fragment, if present, and remove the fragment
 * from the visible URL. Safe to call more than once: only the first fragment
 * ever wins, so a later navigation can never replace the tab's token.
 */
export function bootstrapToken(): string | null {
  if (tabToken !== null) {
    return tabToken;
  }
  const hash = window.location.hash;
  if (hash.length > 1) {
    const params = new URLSearchParams(hash.slice(1));
    const candidate = params.get(TOKEN_KEY);
    if (candidate !== null && candidate.length > 0) {
      tabToken = candidate;
      params.delete(TOKEN_KEY);
      const remaining = params.toString();
      window.history.replaceState(
        null,
        "",
        window.location.pathname + (remaining.length > 0 ? `#${remaining}` : ""),
      );
    }
  }
  return tabToken;
}

/** The token for this tab, or ``null`` when the tab was not launched with one. */
export function getToken(): string | null {
  return tabToken;
}

/** Forget the token (used by tests and by a future "sign out" action). */
export function clearToken(): void {
  tabToken = null;
}
