/**
 * The compact app shell: keyboard-accessible navigation for the five V1
 * screens, a token/connection state, and screen bodies.
 *
 * The Setup screen (readiness, explicitly consented model download,
 * progress, recovery, safe diagnostics), the Recipes screen (form-based
 * recipe listing, creation, editing, duplication, validation, import,
 * export, deletion), the Try-a-decision screen (bounded text or JSON
 * input, one request per run, no implicit retry, complete primitive-specific
 * results with review state separate from probability), the
 * Connections screen (server-generated MCP configuration for Claude Code,
 * OpenCode, and VS Code/GitHub Copilot, copy-only, with setup,
 * verification, restart, and removal guidance), and the Settings screen
 * (app and version information, the read-only data directory, bundled
 * project and third-party notices, the confirmed history opt-in/opt-out
 * and clear, confirmed local model removal with the exact-profile
 * confirmation, and the shared safe diagnostics) are implemented.
 *
 * A screen can register a leave guard: while the guard is set, unsaved-edit
 * protection is active. It covers every way out of the screen:
 *   - clicking a navigation link asks the guard first and can be blocked;
 *   - browser Back/Forward (a ``hashchange`` to another screen) is intercepted,
 *     the hash is restored to the current screen, and the guard's
 *     confirmation is shown, so the form survives;
 *   - refresh and tab close fire ``beforeunload``, which prompts the browser.
 * The form is preserved until the user confirms the discard.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, request } from "./api";
import { ConnectionsScreen } from "./connections";
import { DecisionScreen } from "./decision";
import { RecipesScreen, type LeaveGuard } from "./recipes";
import { SettingsScreen } from "./settings";
import { SetupScreen } from "./setup";
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
  setLeaveGuard,
}: {
  screen: (typeof SCREENS)[number];
  state: ConnectionState;
  setLeaveGuard: (guard: LeaveGuard | null) => void;
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
  if (screen.id === "setup") {
    return <SetupScreen />;
  }
  if (screen.id === "try-a-decision") {
    return <DecisionScreen />;
  }
  if (screen.id === "recipes") {
    return <RecipesScreen setLeaveGuard={setLeaveGuard} />;
  }
  if (screen.id === "connections") {
    return <ConnectionsScreen />;
  }
  if (screen.id === "settings") {
    return <SettingsScreen />;
  }
  return null;
}

export function App() {
  const [screen, setScreen] = useState<ScreenId>(readScreen);
  const [state, setState] = useState<ConnectionState>(() =>
    getToken() === null ? { kind: "missing" } : { kind: "checking" },
  );
  const leaveGuard = useRef<LeaveGuard | null>(null);
  const [guardActive, setGuardActive] = useState(false);
  const screenRef = useRef(screen);
  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);
  const setLeaveGuard = useCallback((guard: LeaveGuard | null) => {
    leaveGuard.current = guard;
    setGuardActive(guard !== null);
  }, []);

  // A hash change to another screen (browser Back/Forward, or a direct hash
  // edit) must not silently discard unsaved edits: while a guard is active it
  // is asked first, and if it blocks, the hash is restored to the current
  // screen so the app stays put and the guard's confirmation is shown.
  useEffect(() => {
    const onChange = () => {
      const next = readScreen();
      if (next !== screenRef.current && leaveGuard.current !== null) {
        if (leaveGuard.current(next)) {
          window.location.hash = `#/${screenRef.current}`;
          return;
        }
      }
      setScreen(next);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  // Refresh and tab close must not silently discard unsaved edits either:
  // while a guard is active, ``beforeunload`` prompts the browser.
  useEffect(() => {
    if (!guardActive) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [guardActive]);

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

  // On a screen change (never the initial load), focus moves to the new
  // screen's heading so keyboard and screen-reader users land on the page
  // they opened instead of staying in the navigation.
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef(screen);
  useEffect(() => {
    if (shown.current !== screen) {
      shown.current = screen;
      heading.current?.focus();
    }
  }, [screen]);

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
                  onClick={(event) => {
                    if (
                      s.id !== screen &&
                      leaveGuard.current !== null &&
                      leaveGuard.current(s.id)
                    ) {
                      event.preventDefault();
                    }
                  }}
                >
                  {s.name}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main>
        <h1 ref={heading} tabIndex={-1}>
          {active.name}
        </h1>
        <ScreenBody screen={active} state={state} setLeaveGuard={setLeaveGuard} />
      </main>
    </div>
  );
}
