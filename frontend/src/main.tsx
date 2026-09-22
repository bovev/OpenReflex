import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { bootstrapToken } from "./token";
import "./styles.css";

// Extract the token from the launch fragment before anything renders, and
// keep it in tab-scoped memory only.
bootstrapToken();

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("the application root element is missing");
}
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
