/**
 * Same-origin client for the local ``/v1`` API.
 *
 * - Only local paths of the form ``/v1`` or ``/v1/...`` are accepted.
 *   Absolute URLs, protocol-relative URLs, backslashes, encoded separators,
 *   dot segments in any literal, encoded, or mixed form, query strings,
 *   fragments, and control characters are rejected before ``fetch`` is
 *   called, so the token can never leave the app's own origin.
 * - The bearer token is sent only in the ``Authorization`` header, never in
 *   the URL, query string, or body, and never in an error message.
 * - Product error envelopes (``code``, ``message``, ``request_id``, ``issues``)
 *   are surfaced as :class:`ApiError`, including the server's request id.
 * - Requests support cancellation through ``AbortSignal``.
 * - There is deliberately no retry logic: a failed mutation is reported to the
 *   caller exactly once and never repeated implicitly.
 */

import { getToken } from "./token";

export interface ErrorIssue {
  readonly location: string;
  readonly message: string;
}

interface ErrorEnvelope {
  code?: string;
  message?: string;
  request_id?: string | null;
  issues?: ErrorIssue[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly issues: readonly ErrorIssue[];

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string | null,
    issues: readonly ErrorIssue[],
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.issues = issues;
  }
}

export class CanceledError extends Error {
  constructor() {
    super("the request was canceled");
    this.name = "CanceledError";
  }
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
}

/**
 * Reject anything that is not a local ``/v1`` API path, before ``fetch`` is
 * called.
 *
 * Accepted: ``/v1`` and ``/v1/<segments>`` with ordinary path characters
 * (including valid percent-escapes such as ``%20``).
 *
 * Rejected, because the effective target would be ambiguous or off-origin:
 * absolute URLs (``https://host/...`` — never start with ``/``),
 * protocol-relative URLs (``//host/...`` — double slash), backslashes (the
 * URL parser treats them as separators for ``http(s)``), encoded separators
 * (``%2F`` / ``%5C``), dot segments in any form the URL parser recognizes —
 * literal (``/v1/../x``), encoded (``/v1/%2e%2e/x``), or mixed
 * literal/encoded (``/v1/.%2e/x``, ``/v1/%2E./x``), in any case of the hex
 * digits — all of which normalize off the ``/v1`` prefix, query strings and
 * fragments (owned by the client, not the path), whitespace and
 * control/format characters (the URL parser strips some of them, changing
 * the effective target), and malformed percent-escapes.
 */
function assertLocalApiPath(path: string): void {
  // The path must be an absolute local path starting with exactly one
  // slash. This rejects absolute URLs (no scheme starts with "/") and,
  // together with the double-slash check below, protocol-relative URLs.
  if (!path.startsWith("/")) {
    throw invalidPathError();
  }
  // Approved shape: "/v1" or "/v1/<something>".
  if (!path.startsWith("/v1") || (path.length > 3 && path[3] !== "/")) {
    throw invalidPathError();
  }
  // No double slashes anywhere: blocks "//host" escapes and empty segments.
  if (path.includes("//")) {
    throw invalidPathError();
  }
  // No backslashes: the URL parser normalizes them to separators for
  // http(s), so "\v1\..." or "/v1\..." are ambiguous forms.
  if (path.includes("\\")) {
    throw invalidPathError();
  }
  // No encoded separators, whatever the case of the hex digits.
  const lower = path.toLowerCase();
  if (lower.includes("%2f") || lower.includes("%5c")) {
    throw invalidPathError();
  }
  // No query string or fragment: the client owns those, and a "?"/"#"
  // inside the path makes the effective target ambiguous.
  if (path.includes("?") || path.includes("#")) {
    throw invalidPathError();
  }
  // No whitespace, control, or format characters: the URL parser strips
  // some of them (leading/trailing C0 or space, embedded tab/newline),
  // which changes the effective target.
  if (/[\s\p{C}]/u.test(path)) {
    throw invalidPathError();
  }
  // Every percent sign must start a valid two-hex-digit escape; anything
  // else is a malformed URL with an ambiguous target.
  for (let i = 0; i < path.length; i++) {
    if (path[i] === "%") {
      if (!/^[0-9a-f]{2}$/i.test(path.slice(i + 1, i + 3))) {
        throw invalidPathError();
      }
      i += 2;
    }
  }
  // No dot segments in the form the URL parser sees. Browsers decode
  // percent-escapes before normalizing dot segments, so an encoded dot
  // ("%2e", "%2E") or a mixed literal/encoded dot (".%2e", "%2E.")
  // becomes "." or ".." and would move the request off the /v1 prefix.
  // Literal "." and ".." survive decoding unchanged, so checking the
  // decoded form covers every form in one pass. Decoding cannot introduce
  // a separator here: "%2F" and "%5C" were already rejected above.
  for (const segment of percentDecode(path).split("/")) {
    if (segment === "." || segment === "..") {
      throw invalidPathError();
    }
  }
}

/**
 * Decode the percent-escapes of a path into the characters the URL parser
 * will treat the path as. Only called after every escape has been
 * validated and no ``%2F``/``%5C`` is present, so decoding can never
 * introduce a separator or a lone surrogate (two hex digits are 0x00-0xFF).
 */
function percentDecode(path: string): string {
  let out = "";
  for (let i = 0; i < path.length; i++) {
    if (path[i] === "%") {
      out += String.fromCharCode(Number.parseInt(path.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out += path[i];
    }
  }
  return out;
}

function invalidPathError(): ApiError {
  // Fixed message: the offending path is never echoed, so caller-supplied
  // text (including anything that looks like a token) cannot reach error
  // text, logs, or rendered content.
  return new ApiError(
    0,
    "invalid_path",
    "the request path must be a local /v1 API path",
    null,
    [],
  );
}

/**
 * Perform one request against the local service. The path must be a local
 * ``/v1`` API path (see :func:`assertLocalApiPath`); the service enforces
 * the token, Host, and Origin on its side.
 */
export async function request<T>(
  method: string,
  path: string,
  body: unknown = undefined,
  options: RequestOptions = {},
): Promise<T> {
  assertLocalApiPath(path);
  const token = getToken();
  if (token === null) {
    throw new ApiError(0, "unauthorized", "no token is available for this tab", null, []);
  }
  if (options.signal?.aborted) {
    throw new CanceledError();
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new CanceledError();
    }
    throw new ApiError(0, "network", "could not reach the local service", null, []);
  }

  let envelope: ErrorEnvelope | null = null;
  const text = await response.text();
  if (text.length > 0) {
    try {
      envelope = JSON.parse(text) as ErrorEnvelope;
    } catch {
      envelope = null;
    }
  }
  const requestId =
    (envelope?.request_id ?? null) ?? response.headers.get("x-request-id");

  if (!response.ok) {
    throw new ApiError(
      response.status,
      envelope?.code ?? "network",
      envelope?.message ?? `the service rejected the request (${response.status})`,
      requestId,
      envelope?.issues ?? [],
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  if (envelope === null) {
    throw new ApiError(
      response.status,
      "network",
      "the service returned an unreadable response",
      requestId,
      [],
    );
  }
  return envelope as T;
}
