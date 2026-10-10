// The pages of the documentation, by the last part of their address. One list, used by the server
// (which answers these addresses with the site's page and no others) and by the site's own router.

export const DOC_SLUGS = ["fees", "chains", "refunds", "safety", "private", "ghost-mode", "add-gas", "rewards", "faq"] as const;
export type DocSlug = (typeof DOC_SLUGS)[number];

/**
 * The page that explains private routing. It is a page only where the server routes swaps
 * privately. Everywhere else its address is no page at all: the server answers it with "not
 * found", the site shows "Page not found.", and nothing links to it.
 */
export const PRIVATE_DOC_SLUG: DocSlug = "private";

/** The page that explains Ghost mode. It is a page everywhere: the switch is in the header however swaps are routed. */
export const GHOST_DOC_SLUG: DocSlug = "ghost-mode";

/**
 * The page that explains Add gas. Like the page on private routing, it is a page only where the
 * server routes swaps privately: gas is only ever added beside a privately routed swap, so
 * anywhere else there is no switch, and nothing to explain.
 */
export const GAS_DOC_SLUG: DocSlug = "add-gas";

/** The pages that exist only where swaps are routed privately. Everywhere else the address of each is no page at all. */
export const PRIVATE_ONLY_DOC_SLUGS: readonly DocSlug[] = [PRIVATE_DOC_SLUG, GAS_DOC_SLUG];

export function isDocSlug(value: string): value is DocSlug {
  return (DOC_SLUGS as readonly string[]).includes(value);
}

/** The documentation's pages as they stand on this site: all of them where private routing is in force, and all but the pages that exist only there where it is not. */
export function docSlugs(privateRouting: boolean): readonly DocSlug[] {
  return privateRouting ? DOC_SLUGS : DOC_SLUGS.filter((slug) => !PRIVATE_ONLY_DOC_SLUGS.includes(slug));
}
