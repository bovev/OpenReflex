import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Start the test-only fake service (``scripts/fake_service.py``): a real
 * loopback OpenReflex service with the deterministic fake engine, an
 * in-memory artifact source, the real auth middleware, a temporary data
 * directory, and no network access.
 */

export interface FakeService {
  readonly baseUrl: string;
  readonly token: string;
  stop(): Promise<void>;
}

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

// The service prints exactly one JSON line on stdout using ``base_url``
// (see ``scripts/fake_service.py``); never ``baseUrl``.
interface Endpoint {
  base_url: string;
  token: string;
}

/**
 * Kill the whole service process tree. ``uv`` spawns the Python service as a
 * child process, so a plain ``child.kill()`` would terminate only the ``uv``
 * wrapper and leak the service. On Windows ``taskkill /T`` removes the whole
 * tree; elsewhere the child is started in its own process group (``detached``)
 * and the group is killed.
 */
function killTree(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
      resolve();
      return;
    }
    let settled = false;
    const done = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const timer = setTimeout(done, 10_000);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)]);
      killer.once("error", done);
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  });
}

function waitForEndpoint(child: ChildProcess, timeoutMs: number): Promise<Endpoint> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    let buffer = "";
    const timer = setTimeout(() => {
      finish(new Error(`timed out waiting for the fake service endpoint\n${stderr}`));
    }, timeoutMs);
    const finish = (error: Error | null, value?: Endpoint): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error !== null) {
        reject(error);
      } else {
        resolve(value as Endpoint);
      }
    };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = buffer.slice(0, newline).trim();
      try {
        const parsed = JSON.parse(line) as Endpoint;
        if (typeof parsed.base_url !== "string" || typeof parsed.token !== "string") {
          throw new Error("the endpoint line is missing base_url or token");
        }
        finish(null, parsed);
      } catch {
        finish(new Error(`bad endpoint line from the fake service: ${line}\n${stderr}`));
      }
    };
    const onExit = (code: number | null): void => {
      finish(
        new Error(
          `the fake service exited before publishing its endpoint (code ${code})\n${stderr}`,
        ),
      );
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("exit", onExit);
    child.once("error", (error: Error) => {
      finish(new Error(`could not start the fake service: ${error.message}`));
    });
  });
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/health/live`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // Not up yet; keep polling.
    }
    if (Date.now() > deadline) {
      throw new Error("the fake service never became healthy");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function startFakeService(): Promise<FakeService> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "openreflex-e2e-"));
  // ``detached`` (non-Windows) puts the child in its own process group so
  // ``killTree`` can remove the whole tree (``uv`` and the Python service).
  const child = spawn(
    "uv",
    [
      "run",
      "--frozen",
      "python",
      path.join(repoRoot, "scripts", "fake_service.py"),
      "--data-dir",
      dataDir,
      "--ui-dir",
      path.join(repoRoot, "frontend", "dist"),
    ],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  try {
    const endpoint = await waitForEndpoint(child, 60_000);
    await waitForHealth(endpoint.base_url, 60_000);
    let stopping = false;
    return {
      baseUrl: endpoint.base_url,
      token: endpoint.token,
      stop: async () => {
        if (stopping) {
          return;
        }
        stopping = true;
        if (child.exitCode === null) {
          // Ask the service to stop through its own authenticated endpoint;
          // force-kill the process tree if it does not exit in time.
          try {
            await fetch(`${endpoint.base_url}/v1/shutdown`, {
              method: "POST",
              headers: { Authorization: `Bearer ${endpoint.token}` },
            });
          } catch {
            // The service may already be gone; the kill below is the fallback.
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              void killTree(child).then(resolve);
            }, 15_000);
            child.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
        await rm(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    // Startup failed: guarantee the service (``uv`` and the Python child) is
    // gone and the temporary data directory is removed, so a failed fixture
    // never leaks a running service.
    await killTree(child);
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}
