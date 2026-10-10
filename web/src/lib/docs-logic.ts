// The documentation's pages, in reading order, and the small rules its layout follows. Kept apart
// from how the pages are drawn so that they can be tested.

import { CHAINS } from "../../../shared/chains.ts";
import { GAS_USD, gasSizeFor } from "../../../shared/gas.ts";
import { GAS_DOC_SLUG, GHOST_DOC_SLUG, PRIVATE_DOC_SLUG, PRIVATE_ONLY_DOC_SLUGS, type DocSlug } from "../../../shared/pages.ts";

export interface DocPage {
  href: string;
  title: string;
  group: "Guide" | "Legal";
}

export const docHref = (slug: DocSlug | null): string => (slug === null ? "/docs" : `/docs/${slug}`);

/**
 * Every page that shares the documentation's layout where swaps are routed in public, in the order
 * its contents list and its previous and next links follow. This is the list anything gets that
 * does not say how swaps are routed, so the two pages below can never be listed by oversight.
 */
export const DOC_PAGES: readonly DocPage[] = [
  { href: "/docs", title: "How it works", group: "Guide" },
  { href: "/docs/fees", title: "Fees", group: "Guide" },
  { href: "/docs/chains", title: "Supported chains", group: "Guide" },
  { href: "/docs/refunds", title: "Refunds and deadlines", group: "Guide" },
  { href: "/docs/safety", title: "Staying safe", group: "Guide" },
  { href: "/docs/ghost-mode", title: "Ghost mode", group: "Guide" },
  { href: "/docs/rewards", title: "Points and weekly rewards", group: "Guide" },
  { href: "/docs/faq", title: "Questions", group: "Guide" },
  { href: "/terms", title: "Terms of Use", group: "Legal" },
  { href: "/privacy", title: "Privacy Policy", group: "Legal" },
];

/** The page that explains private routing. It is one of the documentation's pages only where private routing is in force. */
export const PRIVATE_DOC: DocPage = { href: docHref(PRIVATE_DOC_SLUG), title: "Private routing", group: "Guide" };

/** The page it follows in the contents. */
const BEFORE_PRIVATE_DOC = docHref("safety");

/** The page that explains Add gas. Gas is only ever added beside a privately routed swap, so this too is one of the documentation's pages only where private routing is in force. */
export const GAS_DOC: DocPage = { href: docHref(GAS_DOC_SLUG), title: "Add gas", group: "Guide" };

/** The page it follows in the contents. */
const BEFORE_GAS_DOC = docHref(GHOST_DOC_SLUG);

/** The documentation's pages as they stand on this site. Where private routing is in force, the page that explains it follows "Staying safe", and the page on Add gas follows "Ghost mode". */
export function docPages(privateRouting: boolean): readonly DocPage[] {
  if (!privateRouting) return DOC_PAGES;
  return DOC_PAGES.flatMap((page) => (page.href === BEFORE_PRIVATE_DOC ? [page, PRIVATE_DOC] : page.href === BEFORE_GAS_DOC ? [page, GAS_DOC] : [page]));
}

/** True for a page of the documentation that exists on this site. The page on private routing and the page on Add gas exist only where private routing is in force. */
export function docExists(slug: DocSlug | null, privateRouting: boolean): boolean {
  return privateRouting || slug === null || !PRIVATE_ONLY_DOC_SLUGS.includes(slug);
}

/** Names as they are said in a sentence: "A", "A and B", "A, B and C". */
export function listed(names: readonly string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
}

/**
 * The sizes a gas order comes in, as the page on Add gas says them: the usual one in whole US
 * dollars, then each larger one with the chains it is for, by name, smallest first. Worked out from
 * the rule the server itself uses (shared/gas.ts) over every chain the site knows, so that what the
 * page says cannot drift from what is done.
 */
export function gasSizes(): { usual: number; larger: { usd: number; chains: string[] }[] } {
  const larger = new Map<number, string[]>();
  for (const chain of CHAINS.values()) {
    const usd = gasSizeFor(chain.key);
    if (usd !== GAS_USD) larger.set(usd, [...(larger.get(usd) ?? []), chain.name]);
  }
  return { usual: GAS_USD, larger: [...larger.entries()].sort(([a], [b]) => a - b).map(([usd, chains]) => ({ usd, chains })) };
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
