import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionsScreen } from "../src/connections";
import type { ClientConnection, ConnectionListing } from "../src/connectionsModel";
import { bootstrapToken, clearToken } from "../src/token";

const TOKEN = "tok-connections-123";
const SCHEMA_VERIFIED = "2026-09-21";
// A packaged path with spaces, exactly as the service resolves it on
// Windows.
const EXECUTABLE = "C:\\Program Files\\OpenReflex\\openreflex-mcp.exe";

// The service's standing notes (openreflex.clients), verbatim: external
// clients are not offline, and OpenReflex never touches a client's
// configuration.
const PRIVACY_NOTE =
  "Connecting an external AI client does not make the workflow offline: " +
  "Claude, Copilot, and OpenCode may process the content you send them " +
  "remotely under their own terms. The model and your recipes stay on " +
  "this computer; the client is only a front door.";
const CONFIGURATION_POLICY =
  "OpenReflex never reads, merges, or overwrites your client configuration. " +
  "Apply the generated JSON manually and keep every existing entry.";

// Fixtures mirror the backend generator's output (openreflex.clients) for
// the installed executable, so the assertions hold for the real service
// payload, not just the fixture.
function claudeCodeFixture(executable: string): ClientConnection {
  return {
    client: "claude-code",
    name: "Claude Code",
    config: {
      mcpServers: {
        openreflex: { command: executable, args: [], env: {} },
      },
    },
    setup: [
      "Merge the JSON below into your Claude Code MCP configuration (user " +
        "scope: ~/.claude.json, or project scope: .mcp.json). Keep every " +
        "existing entry; add only the 'openreflex' server.",
    ],
    verification: [
      "Check the connection with 'claude mcp get openreflex' (or /mcp " +
        "inside a session).",
    ],
    restart: ["Restart Claude Code so it starts the MCP server."],
    removal: [
      "Remove the 'openreflex' entry you added ('claude mcp remove " +
        "openreflex'), keep every other entry, and restart Claude Code.",
    ],
    schema_source: "https://docs.anthropic.com/en/docs/claude-code/mcp",
    schema_verified: SCHEMA_VERIFIED,
  };
}

function opencodeFixture(executable: string): ClientConnection {
  return {
    client: "opencode",
    name: "OpenCode",
    config: {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        openreflex: { type: "local", command: [executable], enabled: true },
      },
    },
    setup: [
      "Merge the JSON below into your OpenCode configuration (user scope: " +
        "~/.config/opencode/opencode.json, or the project's opencode.json). " +
        "Keep every existing entry; add only the 'openreflex' server.",
    ],
    verification: [
      "Check the connection in your OpenCode session with the /mcp " +
        "command, which lists the configured MCP servers and their status.",
    ],
    restart: ["Restart your OpenCode session so it starts the MCP server."],
    removal: [
      "Remove the 'openreflex' entry you added from the same configuration " +
        "file, keep every other entry, and restart the session.",
    ],
    schema_source: "https://opencode.ai/docs/mcp-servers",
    schema_verified: SCHEMA_VERIFIED,
  };
}

function vscodeCopilotFixture(executable: string): ClientConnection {
  return {
    client: "vscode-copilot",
    name: "VS Code / GitHub Copilot",
    config: {
      servers: {
        openreflex: { type: "stdio", command: executable, args: [], env: {} },
      },
    },
    setup: [
      "Merge the JSON below into your VS Code MCP configuration (workspace " +
        ".vscode/mcp.json or the user profile mcp.json) or your Copilot " +
        "configuration (workspace .mcp.json or ~/.copilot/mcp-config.json). " +
        "Keep every existing entry; add only the 'openreflex' server.",
    ],
    verification: [
      "Check the connection in the VS Code Chat view, where the " +
        "openreflex server's status is shown (or in the Copilot chat " +
        "panel for portable Copilot configuration).",
    ],
    restart: [
      "Reload the VS Code window (or restart the Copilot session) so it " +
        "starts the MCP server.",
    ],
    removal: [
      "Remove the 'openreflex' entry you added from the same configuration, " +
        "keep every other entry, and reload the window.",
    ],
    schema_source:
      "https://code.visualstudio.com/docs/copilot/customization/mcp-servers; " +
      "https://docs.github.com/en/copilot/how-tos/provide-context/" +
      "use-mcp-in-your-ide/extend-copilot-chat-with-mcp",
    schema_verified: SCHEMA_VERIFIED,
  };
}

function listingFixture(executable: string): ConnectionListing {
  return {
    privacy_note: PRIVACY_NOTE,
    configuration_policy: CONFIGURATION_POLICY,
    clients: [
      claudeCodeFixture(executable),
      opencodeFixture(executable),
      vscodeCopilotFixture(executable),
    ],
  };
}

interface StubHeaders {
  get: (name: string) => string | null;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    lower[key.toLowerCase()] = value;
  }
  const headerStub: StubHeaders = { get: (name: string) => lower[name.toLowerCase()] ?? null };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headerStub,
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

function setupFetch(handler: (method: string, url: string) => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    return Promise.resolve(handler(method, input));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function callsTo(
  fetchMock: ReturnType<typeof vi.fn>,
  method: string,
  url: string,
): number {
  return fetchMock.mock.calls.filter(
    ([urlArg, init]) =>
      urlArg === url && ((init as RequestInit | undefined)?.method ?? "GET") === method,
  ).length;
}

beforeEach(() => {
  window.location.hash = `#token=${TOKEN}`;
  bootstrapToken();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearToken();
});

async function renderConnections(): Promise<void> {
  render(<ConnectionsScreen />);
  await vi.waitFor(() => {
    expect(
      screen.queryByTestId("connections") !== null ||
        screen.queryByTestId("connections-error") !== null,
    ).toBe(true);
  });
}

describe("connections screen", () => {
  it("covers Claude Code, OpenCode, and VS Code/GitHub Copilot, and never presents Claude Desktop as required", async () => {
    setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/connections") {
        return jsonResponse(200, listingFixture(EXECUTABLE));
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderConnections();

    expect(screen.getByTestId("client-claude-code").textContent).toContain("Claude Code");
    expect(screen.getByTestId("client-opencode").textContent).toContain("OpenCode");
    expect(screen.getByTestId("client-vscode-copilot").textContent).toContain(
      "VS Code / GitHub Copilot",
    );
    // Claude Desktop is not a V1 client: it must not be presented at all.
    expect(document.body.textContent).not.toContain("Claude Desktop");

    // Each client shows its setup (location/scope), restart, and removal
    // guidance from the service.
    const claudeSetup = screen.getByTestId("setup-steps-claude-code").textContent ?? "";
    expect(claudeSetup).toContain("~/.claude.json");
    expect(screen.getByTestId("restart-steps-claude-code").textContent).toContain(
      "Restart Claude Code",
    );
    expect(screen.getByTestId("removal-steps-claude-code").textContent).toContain(
      "claude mcp remove openreflex",
    );
    expect(screen.getByTestId("restart-steps-opencode").textContent).toContain(
      "Restart your OpenCode session",
    );
    expect(screen.getByTestId("restart-steps-vscode-copilot").textContent).toContain(
      "Reload the VS Code window",
    );

    // Every required client has a dedicated, non-empty verification
    // section (server-owned, not reconstructed in the frontend).
    const claudeVerification =
      screen.getByTestId("verification-steps-claude-code").textContent ?? "";
    expect(claudeVerification).toContain("claude mcp get openreflex");
    const openCodeVerification =
      screen.getByTestId("verification-steps-opencode").textContent ?? "";
    expect(openCodeVerification).toContain("/mcp command");
    const copilotVerification =
      screen.getByTestId("verification-steps-vscode-copilot").textContent ?? "";
    expect(copilotVerification).toContain("VS Code Chat view");
  });

  it("shows the exact server-generated configuration for every client, not a reconstructed shape", async () => {
    const listing = listingFixture(EXECUTABLE);
    setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/connections") {
        return jsonResponse(200, listing);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderConnections();

    for (const client of listing.clients) {
      const shown = screen.getByTestId(`config-${client.client}`).textContent ?? "";
      // The displayed snippet is the serialization of the exact object the
      // service generated - keys, values, and order included. This exact
      // match also proves the server's executable path is carried through
      // (JSON-escaped, as the service generates it).
      expect(shown).toBe(JSON.stringify(client.config, null, 2));
    }
  });

  it("shows the privacy/locality explanation before any setup step", async () => {
    setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/connections") {
        return jsonResponse(200, listingFixture(EXECUTABLE));
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderConnections();

    const privacy = screen.getByTestId("privacy-note");
    expect(privacy.textContent).toContain("remotely under their own terms");
    expect(privacy.textContent).toContain("stay on this computer");
    for (const id of ["claude-code", "opencode", "vscode-copilot"]) {
      const setup = screen.getByTestId(`setup-steps-${id}`);
      expect(privacy.compareDocumentPosition(setup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // The merge guidance (preserve unrelated entries) is also before the
    // setup steps.
    const merge = screen.getByTestId("merge-guidance");
    expect(
      merge.compareDocumentPosition(screen.getByTestId("setup-steps-claude-code")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("setup and removal guidance explicitly preserves unrelated user configuration", async () => {
    setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/connections") {
        return jsonResponse(200, listingFixture(EXECUTABLE));
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderConnections();

    for (const id of ["claude-code", "opencode", "vscode-copilot"]) {
      const setup = screen.getByTestId(`setup-steps-${id}`).textContent ?? "";
      expect(setup).toContain("Keep every existing entry; add only the 'openreflex' server");
      const removal = screen.getByTestId(`removal-steps-${id}`).textContent ?? "";
      expect(removal).toContain("keep every other entry");
    }
    expect(screen.getByTestId("configuration-policy").textContent).toContain(
      "never reads, merges, or overwrites",
    );
    expect(screen.getByTestId("merge-guidance").textContent).toContain(
      "Keep every other MCP server and every other setting exactly as they are",
    );
  });

  it("copies the configuration on an explicit click with success feedback, and never reads the clipboard", async () => {
    // user-event is set up before the navigator stub: user-event attaches
    // its own clipboard stub to whatever navigator exists at setup time,
    // so the stub must replace the navigator afterwards to stay visible
    // to the screen.
    const user = userEvent.setup();
    const writeText = vi.fn((_text: string) => Promise.resolve(undefined));
    const readText = vi.fn(() => Promise.resolve(""));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText, readText } });
    const listing = listingFixture(EXECUTABLE);
    setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/connections") {
        return jsonResponse(200, listing);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderConnections();

    // Keyboard operation: the copy control is a native button - it takes
    // focus, and activating the focused button with the Enter key fires
    // the action. (user-event performs the browser's keyboard activation
    // behavior, which jsdom does not implement on its own.)
    const button = screen.getByTestId("copy-claude-code");
    button.focus();
    expect(document.activeElement).toBe(button);
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toBe(
      JSON.stringify(listing.clients[0].config, null, 2),
    );
    await vi.waitFor(() =>
      expect(screen.getByTestId("copy-status-claude-code").textContent).toContain(
        "Copied to the clipboard",
      ),
    );
    // No automatic clipboard read, ever.
    expect(readText).not.toHaveBeenCalled();
  });

  it("shows an explicit failure when the clipboard write fails, and keeps the snippet visible", async () => {
    const writeText = vi.fn(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/connections") {
        return jsonResponse(200, listingFixture(EXECUTABLE));
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderConnections();

    fireEvent.click(screen.getByTestId("copy-opencode"));
    await vi.waitFor(() => expect(screen.queryByTestId("copy-error-opencode")).toBeTruthy());
    expect(screen.getByTestId("copy-error-opencode").textContent).toContain("Copy failed");
    // The configuration stays visible for manual copying.
    expect(screen.getByTestId("config-opencode").textContent).not.toBe("");
  });

  it("reports a missing configuration per client without hiding the other clients", async () => {
    const listing = listingFixture(EXECUTABLE);
    const broken: ClientConnection = { ...listing.clients[1], config: {} };
    setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/connections") {
        return jsonResponse(200, {
          ...listing,
          clients: [listing.clients[0], broken, listing.clients[2]],
        });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderConnections();

    expect(screen.getByTestId("config-missing-opencode").textContent).toContain(
      "did not return a configuration",
    );
    expect(screen.queryByTestId("copy-opencode")).toBeNull();
    expect(screen.queryByTestId("config-opencode")).toBeNull();
    // The other clients are unaffected.
    expect(screen.getByTestId("config-claude-code").textContent).not.toBe("");
    expect(screen.getByTestId("copy-claude-code")).toBeTruthy();
    expect(screen.getByTestId("config-vscode-copilot").textContent).not.toBe("");
  });

  it("shows an API failure with a retry, and the retry reloads", async () => {
    let attempts = 0;
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/connections") {
        attempts += 1;
        if (attempts === 1) {
          return jsonResponse(500, {
            code: "internal",
            message: "internal error",
            request_id: "rid-1",
          });
        }
        return jsonResponse(200, listingFixture(EXECUTABLE));
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    render(<ConnectionsScreen />);
    await vi.waitFor(() => expect(screen.queryByTestId("connections-error")).toBeTruthy());
    expect(screen.getByTestId("connections-error").textContent).toContain("internal error");

    // Keyboard operation on the retry control: the Space key activates
    // the focused button (user-event performs the browser's keyboard
    // activation behavior, which jsdom does not implement on its own).
    const user = userEvent.setup();
    const retry = screen.getByTestId("connections-retry");
    retry.focus();
    expect(document.activeElement).toBe(retry);
    await user.keyboard(" ");
    await vi.waitFor(() => expect(screen.queryByTestId("connections")).toBeTruthy());
    expect(attempts).toBe(2);
    expect(callsTo(fetchMock, "GET", "/v1/connections")).toBe(2);
  });

  it("treats an unreadable payload as a load error, and recovers on retry", async () => {
    let attempts = 0;
    setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/connections") {
        attempts += 1;
        if (attempts === 1) {
          return jsonResponse(200, {
            privacy_note: PRIVACY_NOTE,
            configuration_policy: CONFIGURATION_POLICY,
            clients: "not-an-array",
          });
        }
        return jsonResponse(200, listingFixture(EXECUTABLE));
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    render(<ConnectionsScreen />);
    await vi.waitFor(() => expect(screen.queryByTestId("connections-error")).toBeTruthy());
    expect(screen.getByTestId("connections-error").textContent).toContain("unreadable");

    fireEvent.click(screen.getByTestId("connections-retry"));
    await vi.waitFor(() => expect(screen.queryByTestId("connections")).toBeTruthy());
    expect(attempts).toBe(2);
  });

  it("displays JSON-escaped paths (spaces, backslashes, quotes, non-ASCII) intact", async () => {
    // A path that exercises every class of JSON escaping the service
    // applies: spaces, backslashes, a double quote, and non-ASCII.
    const escaped = 'C:\\Program Files\\O"pen\\Ünïcode\\openreflex-mcp.exe';
    const listing = listingFixture(escaped);
    setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/connections") {
        return jsonResponse(200, listing);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderConnections();

    const shown = screen.getByTestId("config-claude-code").textContent ?? "";
    expect(shown).toBe(JSON.stringify(listing.clients[0].config, null, 2));
    // Backslashes doubled, the quote escaped, the non-ASCII kept as-is.
    expect(shown).toContain(
      '"command": "C:\\\\Program Files\\\\O\\"pen\\\\Ünïcode\\\\openreflex-mcp.exe"',
    );
    // OpenCode's command-array form escapes identically (the array
    // element is on its own line in the 2-space serialization).
    const openCode = screen.getByTestId("config-opencode").textContent ?? "";
    expect(openCode).toContain(
      '"C:\\\\Program Files\\\\O\\"pen\\\\Ünïcode\\\\openreflex-mcp.exe"',
    );
  });

  it("issues only the read-only GET /v1/connections request, even after a copy", async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve(undefined));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const fetchMock = setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/connections") {
        return jsonResponse(200, listingFixture(EXECUTABLE));
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderConnections();

    fireEvent.click(screen.getByTestId("copy-vscode-copilot"));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    // Nothing but the read-only listing request is ever issued: no
    // mutation, no configuration write, no client launch.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const [urlArg, init] of fetchMock.mock.calls) {
      expect(urlArg).toBe("/v1/connections");
      expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
    }
  });

  it("never renders the sign-in token", async () => {
    setupFetch((method, url) => {
      if (method === "GET" && url === "/v1/connections") {
        return jsonResponse(200, listingFixture(EXECUTABLE));
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await renderConnections();
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
