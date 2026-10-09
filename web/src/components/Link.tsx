import type { AnchorHTMLAttributes, ReactNode } from "react";
import { navigate } from "../router.ts";

/**
 * A link to another page of this site. A plain press moves within the page already loaded;
 * anything else (a new tab, a new window) is left to the browser, as for any link.
 */
export function Link({ href, children, onNavigate, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode; onNavigate?(): void }) {
  return (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        onNavigate?.();
        navigate(href);
        if (href.includes("#")) document.getElementById(href.split("#")[1] ?? "")?.scrollIntoView();
      }}
    >
      {children}
    </a>
  );
}
