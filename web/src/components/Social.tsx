// The three places IntentSwap is found elsewhere, as icon links: DexScreener, GitHub, X, in that
// order. They stand in the header on a wide screen, in the menu on a phone, and in the footer.
// Where each leads is a setting on the server. While one is not set its icon is still there and
// looks the same, and a press on it goes nowhere.

import type { ReactNode } from "react";
import { socialLinks, type SocialKey } from "../lib/site-logic.ts";
import { useApp } from "../stores/app.ts";
import { OutboundLink } from "./OutboundLink.tsx";

/**
 * Each mark in one colour (the colour of the text around it), drawn in the same 20 px box and
 * balanced by eye so that none looks larger than the others: a mark that fills its box to the
 * corners (X) is drawn a little smaller than a round one (GitHub), and the tall owl stands between.
 * The X and GitHub marks are the ones those services publish, as redrawn for the Simple Icons set
 * (CC0). DexScreener's owl is the line drawing of its mark from the Arcticons set (CC BY-SA 4.0),
 * with its lines made heavier to stand beside the other two.
 */
export const SOCIAL_MARKS: Record<SocialKey, ReactNode> = {
  dexscreener: (
    <svg viewBox="3 3 42 42" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12.951 10.765c-4.384 7.074.244 15.697-5.366 25.358l4.657-3.436l3.196 5.208l3.23-3.12L24 43.492l5.332-8.715l3.23 3.12l3.196-5.21l4.657 3.437c-5.61-9.66-.982-18.284-5.366-25.358" />
      <path d="m19.89 23.502l-3.424 2.037c4.622.794 6.467 7.03 7.534 12.389c1.067-5.36 2.912-11.595 7.534-12.389l-3.423-2.037c.436-3.3-1.91-6.552-4.111-6.552s-4.547 3.253-4.11 6.552" />
      <path d="M26.522 17.69c4.604-2.337 9.597-6.354 11.318-12.439c-1.07 1.375-2.66 2.767-4.518 3.283a15 15 0 0 0-.685-.66C29.536 5.057 27.25 4.508 24 4.508s-5.536.55-8.637 3.364q-.36.329-.685.661c-1.858-.516-3.449-1.908-4.518-3.283c1.72 6.085 6.714 10.102 11.318 12.44" />
      <path d="M16.049 14.43c-1.098.875-1.352 2.643-.558 3.899c.928 1.47 3.689 2.26 5.117.995m11.343-4.894c1.098.875 1.352 2.643.558 3.899c-.928 1.47-3.689 2.26-5.117.995" />
    </svg>
  ),
  github: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  ),
  x: (
    <svg viewBox="-2.5 -2.5 29 29" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" />
    </svg>
  ),
};

/** The three icons in a row. `where` only names the row for a stylesheet; the icons are the same everywhere. */
export function SocialLinks({ where }: { where: "header" | "menu" | "footer" }) {
  const config = useApp((state) => state.config);
  return (
    <ul className="social" data-where={where}>
      {socialLinks(config).map((link) => (
        <li key={link.key}>
          {link.href !== null ? (
            // A link out like any other on the site: a new tab, and the other site told nothing (see OutboundLink).
            <OutboundLink className="social-link" href={link.href} aria-label={link.label} title={link.label}>
              {SOCIAL_MARKS[link.key]}
            </OutboundLink>
          ) : (
            // No address yet: a link with nowhere to go. It has no href, so a press does nothing at all (no jump to the top of the page, no new tab).
            <a className="social-link" role="link" aria-disabled="true" aria-label={link.label} title={link.label}>
              {SOCIAL_MARKS[link.key]}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
