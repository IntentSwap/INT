// The pages of the documentation, by the last part of their address. One list, used by the server
// (which answers these addresses with the site's page and no others) and by the site's own router.

export const DOC_SLUGS = ["fees", "chains", "refunds", "safety", "private", "ghost-mode", "rewards", "faq"] as const;
export type DocSlug = (typeof DOC_SLUGS)[number];

/**
 * The page that explains private routing. It is a page only where the server routes swaps
 * privately. Everywhere else its address is no page at all: the server answers it with "not
 * found", the site shows "Page not found.", and nothing links to it.
 */
export const PRIVATE_DOC_SLUG: DocSlug = "private";

/** The page that explains Ghost mode. It is a page everywhere: the switch is in the header however swaps are routed. */
export const GHOST_DOC_SLUG: DocSlug = "ghost-mode";

export function isDocSlug(value: string): value is DocSlug {
  return (DOC_SLUGS as readonly string[]).includes(value);
}

/** The documentation's pages as they stand on this site: all of them where private routing is in force, and all but its own page where it is not. */
export function docSlugs(privateRouting: boolean): readonly DocSlug[] {
  return privateRouting ? DOC_SLUGS : DOC_SLUGS.filter((slug) => slug !== PRIVATE_DOC_SLUG);
}
