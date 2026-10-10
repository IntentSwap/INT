import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { watchKeys } from "./lib/keys.ts";
import { watchForNewVersion } from "./lib/stale.ts";
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/base.css";
import "./styles/controls.css";
import "./styles/shell.css";
import "./styles/card.css";
import "./styles/picker.css";
import "./styles/sheet.css";
import "./styles/ghost.css";

watchKeys();
// A page left open across a new version of the site loads itself again, once, when a part of the old version is gone.
watchForNewVersion();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
