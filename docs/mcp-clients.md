# MCP client setup

OpenReflex ships one executable, `openreflex-mcp`, which speaks MCP over stdio and forwards to the local service. V1 supports three MCP clients: **Claude Code**, **OpenCode**, and **VS Code / GitHub Copilot**. Claude Desktop is not required in V1 (owner decision, recorded in [architecture progress](architecture/progress.md)).

## How the configuration is produced

- `openreflex-mcp --print-config <client>` prints the configuration for one client (`claude-code`, `opencode`, or `vscode-copilot`) as a single JSON document on stdout and exits. It does not start the MCP server.
- `GET /v1/connections` (authenticated, read-only) returns the same generated configuration for all clients plus setup, restart, and removal steps. The Connections screen uses it.

Both use the same product-owned generator (`openreflex.clients`), so the output is identical for the same installed executable path. The generated JSON always uses the **absolute** path of the installed `openreflex-mcp` executable and invokes it **directly, without a shell**.

## How the installed path is resolved

Resolution is injectable: the API takes an optional installed-path resolver, and the packaged layout (or a test) can supply the real path through it. With no resolver supplied:

- a frozen `openreflex-mcp` is itself;
- a frozen `openreflex-service` (or any other frozen process) finds it **next to itself** in the packaged two-executable layout — the service executable is never reported as the MCP command;
- in development the console script installed next to the current interpreter is used.

The `--print-config` CLI always uses the built-in resolution, because it only ever runs as `openreflex-mcp` itself.

## Standing promises

- **External clients are not offline.** Claude, Copilot, and OpenCode may process the content you send them remotely under their own terms. The model and your recipes stay on this computer; the client is only a front door.
- **OpenReflex never reads, merges, or overwrites your client configuration.** The generated JSON is a snippet you apply manually. Keep every existing entry; the setup and removal steps below only ever touch the `openreflex` entry.

## Claude Code

Authoritative source: [Claude Code MCP documentation](https://docs.anthropic.com/en/docs/claude-code/mcp). Shape verified against that page on **2026-09-21**.

Configuration location: user scope `~/.claude.json`, or project scope `.mcp.json`.

```json
{
  "mcpServers": {
    "openreflex": {
      "command": "C:\\path\\to\\openreflex-mcp.exe",
      "args": [],
      "env": {}
    }
  }
}
```

1. **Setup** — merge the JSON above into your Claude Code MCP configuration. Keep every existing entry; add only the `openreflex` server.
2. **Restart** — restart Claude Code so it starts the MCP server.
3. **Verification** — check the connection with `claude mcp get openreflex` (or `/mcp` inside a session).
4. **Removal** — remove the `openreflex` entry you added (`claude mcp remove openreflex`), keep every other entry, and restart Claude Code.

## OpenCode

Authoritative source: [OpenCode MCP servers documentation](https://opencode.ai/docs/mcp-servers) (linked from the [configuration reference](https://opencode.ai/docs/config)). Shape verified against those pages on **2026-09-21**.

Configuration location: user scope `~/.config/opencode/opencode.json`, or the project's `opencode.json`.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "openreflex": {
      "type": "local",
      "command": ["C:\\path\\to\\openreflex-mcp.exe"],
      "enabled": true
    }
  }
}
```

1. **Setup** — merge the JSON above into your OpenCode configuration. Keep every existing entry; add only the `openreflex` server. OpenCode's local servers use a `command` array; `type` must be `"local"`.
2. **Restart** — restart your OpenCode session so it starts the MCP server.
3. **Verification** — check the connection in your OpenCode session with the `/mcp` command, which lists the configured MCP servers and their status.
4. **Removal** — remove the `openreflex` entry you added from the same configuration file, keep every other entry, and restart the session.

## VS Code / GitHub Copilot

Authoritative sources: [VS Code MCP servers documentation](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) and [GitHub Copilot's MCP documentation](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp). Shape verified against those pages on **2026-09-21**.

Configuration location: VS Code workspace `.vscode/mcp.json` or the user profile `mcp.json`; for portable Copilot configuration, the workspace `.mcp.json` or the user `~/.copilot/mcp-config.json`.

```json
{
  "servers": {
    "openreflex": {
      "type": "stdio",
      "command": "C:\\path\\to\\openreflex-mcp.exe",
      "args": [],
      "env": {}
    }
  }
}
```

1. **Setup** — merge the JSON above into your VS Code or Copilot MCP configuration. Keep every existing entry; add only the `openreflex` server.
2. **Restart** — reload the VS Code window (or restart the Copilot session) so it starts the MCP server.
3. **Verification** — check the connection in the VS Code Chat view, where the `openreflex` server's status is shown (or in the Copilot chat panel for portable Copilot configuration).
4. **Removal** — remove the `openreflex` entry you added from the same configuration, keep every other entry, and reload the window.

## Keeping the shapes current

If a client changes its configuration format, update `openreflex.clients`, the tests, and the verification date above together. The generator, the CLI, the API, and this page must never drift apart.
