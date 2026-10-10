import { ArrowUpRight } from "lucide-react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { useGhost } from "../stores/ghost.ts";

/**
 * The small mark a link that leaves this site carries in Ghost mode: an arrow pointing up and out,
 * and for a screen reader the words. Outside the mode it draws nothing. Put inside any link that
 * goes to another site; a link drawn with OutboundLink has it already.
 */
export function LeavesSite() {
  const ghost = useGhost((state) => state.on);
  if (!ghost) return null;
  return (
    <span className="leaves-site">
      <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
      <span className="sr-only">(leaves this site)</span>
    </span>
  );
}

/**
 * A link to another site: a block explorer, or one of the places IntentSwap is found elsewhere.
 * It is a plain link the person chooses to press, and nothing more. It opens in a new tab, the
 * other site is not told which page it was pressed on, and it is given no hold on this window.
 * The page itself asks the other site for nothing: not an icon, not a preview. In Ghost mode it
 * carries the mark above.
 *
 * It takes whatever an anchor takes, so it can stand wherever an anchor to another site stands
 * with nothing changed but the name. How it opens is not the caller's to say: whatever is passed
 * for that is set aside, and the three settings below are always the ones in force.
 */
export function OutboundLink({ href, children, target: _target, rel: _rel, referrerPolicy: _referrerPolicy, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) {
  const ghost = useGhost((state) => state.on);
  return (
    <a {...rest} href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" data-leaves={ghost || undefined}>
      {children}
      <LeavesSite />
    </a>
  );
}
