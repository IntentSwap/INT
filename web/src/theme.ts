// Theme: every visit starts in the light theme, whatever the device prefers and whatever was chosen
// before. The toggle switches to the dark theme and back for as long as the page stays loaded;
// nothing is kept, so loading the page again starts in light. The attribute is set before first
// paint by the small script in index.html.

import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const listeners = new Set<() => void>();

function read(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** The theme in use right now. */
export function getTheme(): Theme {
  return read();
}

/** Calls back whenever the theme changes. Returns a way to stop. */
export function onThemeChange(listener: () => void): () => void {
  return subscribe(listener);
}

/** Switches the theme for this visit. Nothing is stored: the next load of the page starts in light again. */
export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => "light");
}
