// Theme: follows the system on a first visit (dark if it states no preference),
// and remembers the person's choice once they use the toggle. The attribute is
// set before first paint by the small script in index.html.

import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const listeners = new Set<() => void>();

function read(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** The theme in use right now. */
export function getTheme(): Theme {
  return read();
}

/** Calls back whenever the theme changes, by the toggle or by the system. Returns a way to stop. */
export function onThemeChange(listener: () => void): () => void {
  return subscribe(listener);
}

function stored(): Theme | null {
  try {
    const value = localStorage.getItem("theme");
    return value === "dark" || value === "light" ? value : null;
  } catch {
    return null;
  }
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("theme", theme);
  } catch {
    // Storage may be unavailable; the choice then lasts for this visit.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Until the person chooses, keep following the system if it changes.
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const onSystem = () => {
    if (stored() !== null) return;
    document.documentElement.dataset.theme = media.matches ? "light" : "dark";
    listener();
  };
  media.addEventListener("change", onSystem);
  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", onSystem);
  };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => "dark");
}
