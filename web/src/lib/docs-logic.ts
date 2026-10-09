// The documentation's pages, in reading order, and the small rules its layout follows. Kept apart
// from how the pages are drawn so that they can be tested.

import { PRIVATE_DOC_SLUG, type DocSlug } from "../../../shared/pages.ts";

export interface DocPage {
  href: string;
  title: string;
  group: "Guide" | "Legal";
}

export const docHref = (slug: DocSlug | null): string => (slug === null ? "/docs" : `/docs/${slug}`);

/**
 * Every page that shares the documentation's layout where swaps are routed in public, in the order
 * its contents list and its previous and next links follow. This is the list anything gets that
 * does not say how swaps are routed, so the page below can never be listed by oversight.
 */
export const DOC_PAGES: readonly DocPage[] = [
  { href: "/docs", title: "How it works", group: "Guide" },
  { href: "/docs/fees", title: "Fees", group: "Guide" },
  { href: "/docs/chains", title: "Supported chains", group: "Guide" },
  { href: "/docs/refunds", title: "Refunds and deadlines", group: "Guide" },
  { href: "/docs/safety", title: "Staying safe", group: "Guide" },
  { href: "/docs/rewards", title: "Points and weekly rewards", group: "Guide" },
  { href: "/docs/faq", title: "Questions", group: "Guide" },
  { href: "/terms", title: "Terms of Use", group: "Legal" },
  { href: "/privacy", title: "Privacy Policy", group: "Legal" },
];

/** The page that explains private routing. It is one of the documentation's pages only where private routing is in force. */
export const PRIVATE_DOC: DocPage = { href: docHref(PRIVATE_DOC_SLUG), title: "Private routing", group: "Guide" };

/** The page it follows in the contents. */
const BEFORE_PRIVATE_DOC = docHref("safety");

/** The documentation's pages as they stand on this site. Where private routing is in force, the page that explains it follows "Staying safe". */
export function docPages(privateRouting: boolean): readonly DocPage[] {
  if (!privateRouting) return DOC_PAGES;
  return DOC_PAGES.flatMap((page) => (page.href === BEFORE_PRIVATE_DOC ? [page, PRIVATE_DOC] : [page]));
}

/** True for a page of the documentation that exists on this site. The page on private routing exists only where private routing is in force. */
export function docExists(slug: DocSlug | null, privateRouting: boolean): boolean {
  return slug !== PRIVATE_DOC_SLUG || privateRouting;
}

/** The pages before and after one, for the links at its foot. Null at either end. */
export function neighbours(href: string, pages: readonly DocPage[] = DOC_PAGES): { previous: DocPage | null; next: DocPage | null } {
  const at = pages.findIndex((page) => page.href === href);
  if (at === -1) return { previous: null, next: null };
  return { previous: pages[at - 1] ?? null, next: pages[at + 1] ?? null };
}

/** A heading's own address within its page: its words in lower case, joined by hyphens. "3. How a swap works" gives "how-a-swap-works". */
export function headingId(title: string): string {
  const id = title
    .toLowerCase()
    .replace(/^\d+\.\s*/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id === "" ? "section" : id;
}

/**
 * Which heading is being read: the last one that has passed the line just under the header. The
 * first one, until any has; the last one, once the page is at its very end (a short last section
 * can never reach the line).
 */
export function headingInView(tops: readonly number[], line: number, atEnd: boolean): number {
  if (tops.length === 0) return -1;
  if (atEnd) return tops.length - 1;
  let current = 0;
  for (let index = 0; index < tops.length; index++) if ((tops[index] ?? Infinity) <= line) current = index;
  return current;
}
