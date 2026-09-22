/**
 * The compact app shell: keyboard-accessible navigation for the five V1
 * screens, a token/connection state, and placeholder screen bodies.
 *
 * Screen-specific workflows (model download, recipe editing, decision
 * execution, connection setup, settings mutations) arrive in later tasks.
 */

import { useEffect, useState } from "react";
import { ApiError, request } from "./api";
import { getToken } from "./token";

export const SCREENS = [
  { id: "setup", name: "Setup" },
  { id: "try-a-decision", name: "Try a decision" },
  { id: "recipes", name: "Recipes" },
  { id: "connections", name: "Connections" },
  { id: "settings", name: "Settings" },
] as const;

export type ScreenId = (typeof SCREENS)[number]["id"];

export function readScreen(): ScreenId {
  const match = window.location.hash.match(/^#\/([a-z][a-z-]*)$/);
  const id = match?.[1];
  return id !== undefined && SCREENS.some((s) => s.id === id) ? (id as ScreenId) : "setup";
}

type ConnectionState =
  | { kind: "missing" }
  | { kind: "checking" }
  | { kind: "ready" }
  | { kind: "rejected"; message: string }
  | { kind: "error"; message: string };

function Recovery({ state }: { state: ConnectionState }) {
  if (state.kind !== "missing" && state.kind !== "rejected") {
    return null;
  }
  const reason =
    state.kind === "missing"
      ? "This tab has no sign-in for the local OpenReflex service."
      : "The sign-in for this tab was rejected by the local service. " + state.message;
  return (
    <div className="recovery" role="alert" data-testid="recovery">
      <h2>Not connected</h2>
      <p>{reason}</p>
      <p>
        Relaunch through OpenReflex: run <code>openreflex-service open</code> (or start
        OpenReflex from the Start menu) and use the tab it opens.
      </p>
    </div>
  );
}

function ScreenBody({
  screen,
  state,
}: {
  screen: (typeof SCREENS)[number];
  state: ConnectionState;
}) {
  if (state.kind === "missing" || state.kind === "rejected") {
    return <Recovery state={state} />;
  }
  if (state.kind === "error") {
    return (
      <p className="error" role="alert" data-testid="service-error">
        {state.message}
      </p>
    );
  }
  if (state.kind === "checking") {
    return <p data-testid="checking">Checking the local service&hellip;</p>;
  }
  return (
    <p data-testid="placeholder">
      {screen.name} is ready. Its workflow arrives in a later task.
    </p>
  );
}

export function App() {
  const [screen, setScreen] = useState<ScreenId>(readScreen);
  const [state, setState] = useState<ConnectionState>(() =>
    getToken() === null ? { kind: "missing" } : { kind: "checking" },
  );

  useEffect(() => {
    const onChange = () => setScreen(readScreen());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  useEffect(() => {
    if (getToken() === null) {
      setState({ kind: "missing" });
      return;
    }
    const controller = new AbortController();
    setState({ kind: "checking" });
    request("GET", "/v1/status", undefined, { signal: controller.signal })
      .then(() => setState({ kind: "ready" }))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === "unauthorized") {
          setState({ kind: "rejected", message: error.message });
        } else {
          const message = error instanceof ApiError ? error.message : "the service is unreachable";
          setState({ kind: "error", message });
        }
      });
    return () => controller.abort();
  }, []);

  const active = SCREENS.find((s) => s.id === screen) ?? SCREENS[0];

  return (
    <div className="shell">
      <header className="topbar">
        <span className="product">OpenReflex</span>
        <nav aria-label="Screens">
          <ul>
            {SCREENS.map((s) => (
              <li key={s.id}>
                <a
                  href={`#/${s.id}`}
                  aria-current={s.id === screen ? "page" : undefined}
                  data-screen={s.id}
                >
                  {s.name}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main>
        <h1>{active.name}</h1>
        <ScreenBody screen={active} state={state} />
      </main>
    </div>
  );
}
