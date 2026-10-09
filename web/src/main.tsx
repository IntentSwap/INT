import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { watchKeys } from "./lib/keys.ts";
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/base.css";
import "./styles/controls.css";
import "./styles/shell.css";
import "./styles/card.css";
import "./styles/picker.css";
import "./styles/sheet.css";

watchKeys();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
