import { createElement, type HTMLAttributes, type ReactNode } from "react";
import { useSeen } from "../lib/reveal.ts";

/**
 * A block whose children come into view one after another, once, the first time it is scrolled to
 * (see "Coming into view" in base.css). It is the block that is watched; its direct children are
 * what moves.
 */
export function Reveal({ as = "div", children, ...rest }: { as?: "div" | "section" | "ul" | "ol" | "dl" | "header" | "article"; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  const [ref, seen] = useSeen<HTMLElement>();
  return createElement(as, { ...rest, ref, "data-reveal": "", "data-in": seen ? "" : undefined }, children);
}
