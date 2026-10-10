// A very small path router. The server answers every app route with the same page.

import { useSyncExternalStore } from "react";
import { isDocSlug, type DocSlug } from "../../shared/pages.ts";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function usePath(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => "/",
  );
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  for (const listener of listeners) listener();
  if (!to.includes("#")) window.scrollTo(0, 0);
}

export type Route =
  | { page: "swap" }
  | { page: "order"; id: string }
  | { page: "track" }
  | { page: "docs"; slug: DocSlug | null }
  | { page: "rewards" }
  | { page: "stats" }
  | { page: "terms" }
  | { page: "privacy" }
  | { page: "token" }
  | { page: "states" }
  | { page: "not-found" };

export function matchRoute(pathname: string): Route {
  if (pathname === "/") return { page: "swap" };
  const order = /^\/order\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
  if (order) return { page: "order", id: order[1] ?? "" };
  if (pathname === "/track") return { page: "track" };
  if (pathname === "/docs") return { page: "docs", slug: null };
  // A page's own part of the address is one word, or words joined by single hyphens ("ghost-mode").
  const doc = /^\/docs\/([a-z]+(?:-[a-z]+)*)$/.exec(pathname);
  if (doc && isDocSlug(doc[1] ?? "")) return { page: "docs", slug: doc[1] as DocSlug };
  if (pathname === "/rewards") return { page: "rewards" };
  if (pathname === "/stats") return { page: "stats" };
  if (pathname === "/terms") return { page: "terms" };
  if (pathname === "/privacy") return { page: "privacy" };
  if (pathname === "/token") return { page: "token" };
  if (pathname === "/states") return { page: "states" };
  return { page: "not-found" };
}

/** The places in the header's navigation, in order. An order's own page belongs to "Track order". */
export const NAV = [
  { href: "/", label: "Swap" },
  { href: "/track", label: "Track order" },
  { href: "/rewards", label: "Rewards" },
  { href: "/stats", label: "Stats" },
  { href: "/docs", label: "Docs" },
] as const;

/** The navigation as it stands on this site: with Stats only where the server has that page switched on. */
export function navItems(statsPage: boolean): readonly (typeof NAV)[number][] {
  return statsPage ? NAV : NAV.filter((item) => item.href !== "/stats");
}

/** Which navigation entry a path belongs to, or null for pages outside it (Terms, Privacy, an unknown address). */
export function navFor(pathname: string): (typeof NAV)[number]["href"] | null {
  const route = matchRoute(pathname);
  if (route.page === "swap") return "/";
  if (route.page === "track" || route.page === "order") return "/track";
  if (route.page === "docs") return "/docs";
  if (route.page === "rewards") return "/rewards";
  if (route.page === "stats") return "/stats";
  return null;
}
