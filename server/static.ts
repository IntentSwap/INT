// Serves the built site from memory with a single-page fallback.
// Only files found in the build folder at startup can ever be served.

import { createHash } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { BANNER_WORDS, type BannerKind } from "../shared/banner.ts";
import { docSlugs, PRIVATE_ONLY_DOC_SLUGS } from "../shared/pages.ts";
import { HEADLINE_SUB, headlineWords, POSITIONING, shareImageAlt, type SiteMode } from "../shared/positioning.ts";
import { SITE_ORIGIN } from "./config.ts";

interface Asset {
  type: string;
  raw: Buffer;
  gzip: Buffer | null;
  brotli: Buffer | null;
  etag: string;
  immutable: boolean;
  daily: boolean;
}

export interface StaticSite {
  /** Serves a page or file. Always responds. */
  handle(req: IncomingMessage, res: ServerResponse, pathname: string): number;
  /** SHA-256 hashes (base64) of the inline scripts in index.html, for the Content-Security-Policy. */
  scriptHashes: string[];
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".webmanifest", ".svg", ".txt"]);

/** Paths the single-page app handles itself. Anything else that is not a file is a 404. */
const APP_ROUTES = [/^\/$/, /^\/order\/[A-Za-z0-9_-]{1,64}$/, /^\/track$/, /^\/docs$/, new RegExp(`^/docs/(${docSlugs(false).join("|")})$`), /^\/rewards$/, /^\/terms$/, /^\/privacy$/];
/** The page that explains private routing, and the page on Add gas (gas is only ever added beside a privately routed swap). They exist only where this server routes swaps privately; everywhere else their addresses are a 404 like any other. */
const PRIVATE_ROUTES = [new RegExp(`^/docs/(${PRIVATE_ONLY_DOC_SLUGS.join("|")})$`)];
/** The token's own page. It exists only once the token's address has been set; until then its address is a 404 like any other. */
const TOKEN_ROUTES = [/^\/token$/];
/** The Stats page. It exists only where the server has it switched on; where it is off its address is a 404 like any other. */
const STATS_ROUTES = [/^\/stats$/];
/** The page of component states: a tool for looking over every component, with made-up content. Never part of the live site. */
const TEST_ROUTES = [/^\/states$/];

function walk(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${base}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    hashes.push(createHash("sha256").update(match[1] ?? "").digest("base64"));
  }
  return hashes;
}

/** The share image as the page names it. Link previews want its full address, which only the server knows. */
const shareImageTag = (image: string) => `content="${image}"`;
/** The two images a page can name: the one the page is built with, and the one a page served with private routing names instead. */
const SHARE_IMAGES = [POSITIONING.public.shareImage, POSITIONING.private.shareImage];

/**
 * The page with the share image's full address in it. A program that draws a link preview does
 * not work out a relative address, so where the site's own address is known it is written in.
 * `siteUrl` is an origin checked at startup (server/config.ts): nothing else is ever put in the page.
 */
export function withSiteUrl(html: string, siteUrl: string): string {
  // Checked again here, where it matters: whatever reaches this function, nothing but a plain address is written into a page.
  if (!SITE_ORIGIN.test(siteUrl)) throw new Error("the site's address is not a plain origin");
  // Functions, not strings: a replacement string gives "$" a meaning of its own.
  let out = html;
  for (const image of SHARE_IMAGES) out = out.replace(shareImageTag(image), () => shareImageTag(`${siteUrl}${image}`));
  return out.replace("</title>", () => `</title>\n    <meta property="og:url" content="${siteUrl}/" />`);
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The headline as the page holds it before any script has run: one span to a word, each with its place in the order the words come up. */
function headlineHtml(mode: SiteMode): string {
  // Two lines, as the page itself draws them: what the site does, then what it is built on.
  const words = headlineWords(mode).map((word, index) => ({ ...word, index }));
  const line = (accent: boolean) =>
    `<span class="headline-line">${words
      .filter((word) => word.accent === accent)
      .map((word) => `<span class="${word.accent ? "headline-word headline-accent" : "headline-word"}" style="--i: ${word.index}">${escapeHtml(word.text)}</span>`)
      .join(" ")}</span>`;
  return `${line(false)} ${line(true)}`;
}

/**
 * Every place in the page that holds the site's first words, as it reads for one of the two sets
 * (shared/positioning.ts). web/index.html holds the public set, and a test holds it to that.
 */
export function firstWords(mode: SiteMode): { what: string; html: string }[] {
  const words = POSITIONING[mode];
  return [
    { what: "the mark on the page itself", html: mode === "private" ? '<html lang="en" data-routing="private">' : '<html lang="en">' },
    { what: "the description", html: `<meta name="description" content="${escapeHtml(words.description)}" />` },
    { what: "the title", html: `<title>${escapeHtml(words.title)}</title>` },
    { what: "the title of a link preview", html: `<meta property="og:title" content="${escapeHtml(words.title)}" />` },
    { what: "the description of a link preview", html: `<meta property="og:description" content="${escapeHtml(words.description)}" />` },
    { what: "the share image", html: `<meta property="og:image" ${shareImageTag(escapeHtml(words.shareImage))} />` },
    { what: "what the share image says", html: `<meta property="og:image:alt" content="${escapeHtml(shareImageAlt(mode))}" />` },
    { what: "the headline", html: `<p class="headline-title">${headlineHtml(mode)}</p>` },
    { what: "the sentence under the headline", html: `<p class="headline-sub muted">${escapeHtml(HEADLINE_SUB)}</p>` },
  ];
}

/**
 * What is changed in the page where private routing is in force: each place that holds the site's
 * first words, as the page is built (`from`, the public words) and as it is then served (`to`).
 * A test holds web/index.html to every `from`, exactly once each: if the page's words are ever
 * changed without this, the test fails, and nothing is served half changed.
 */
export function privateRoutingEdits(): { what: string; from: string; to: string }[] {
  const to = firstWords("private");
  return firstWords("public")
    .map((place, index) => ({ what: place.what, from: place.html, to: to[index]?.html ?? place.html }))
    .filter((edit) => edit.from !== edit.to);
}

/**
 * The page as it is served where this server routes swaps privately: the site's first words are
 * the private ones from the first byte (the headline before any script runs, the title, and what
 * a search result or a link preview shows), and the page is marked, so that its scripts know which
 * words to draw before the server's settings have reached them. The words come from
 * shared/positioning.ts and are escaped all the same. Where swaps are routed in public this is
 * never called, and the page is served exactly as built.
 */
export function withPrivateRouting(html: string): string {
  let out = html;
  // Functions, not strings: a replacement string gives "$" a meaning of its own.
  for (const edit of privateRoutingEdits()) out = out.replace(edit.from, () => edit.to);
  return out;
}

/**
 * The page as it is served where the Stats page is switched off: marked, so that its scripts leave
 * the link out of the navigation from the first moment, before the server's settings have reached them.
 */
export function withoutStats(html: string): string {
  return html.replace('<html lang="en"', () => '<html lang="en" data-stats="off"');
}

/**
 * The page with the rewards wallet's address in it, for a server that has one. The Rewards page
 * draws the pool's frame from it at once, before it has asked what the wallet holds, so that the
 * figures arriving move nothing. Only a plain address is ever written.
 */
export function withRewardsWallet(html: string, address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("the rewards wallet's address is not a plain address");
  return html.replace('<html lang="en"', () => `<html lang="en" data-rewards-wallet="${address}"`);
}

/** Where the page keeps a place for the service banner (web/index.html). */
const BANNER_PLACE = "<!--banner-->";

/**
 * The page with the service banner already in it, for a server that knows from the start that it
 * has one to show (swaps paused). The page's scripts draw the same banner in the
 * same place a moment later, and because it was there already, nothing moves.
 * The sentences come from shared/banner.ts and are escaped all the same.
 */
export function withBanner(html: string, kinds: readonly BannerKind[]): string {
  if (kinds.length === 0) return html;
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const banner = `<div class="banner">${kinds.map((kind) => `<p>${escape(BANNER_WORDS[kind])}</p>`).join("")}</div>`;
  return html.replace(BANNER_PLACE, () => banner);
}

/**
 * The page as it is sent for one address of the site, saying which address is its own (a canonical
 * link): the same page reached by another address is then counted as this one. Only for pages
 * that may be indexed, and only where the site's own address is known.
 */
export function withCanonical(html: string, siteUrl: string, pathname: string): string {
  if (!SITE_ORIGIN.test(siteUrl)) throw new Error("the site's address is not a plain origin");
  if (!/^\/[A-Za-z0-9/_-]{0,80}$/.test(pathname)) throw new Error("not an address of a page");
  return html.replace("</title>", () => `</title>\n    <link rel="canonical" href="${siteUrl}${pathname}" />`);
}

export function loadStaticSite(distDir: string, options: { testPages?: boolean; tokenPage?: boolean; siteUrl?: string | null; banner?: readonly BannerKind[]; privateRouting?: boolean; statsPage?: boolean; rewardsWallet?: string | null } = {}): StaticSite | null {
  const routes = [...APP_ROUTES, ...(options.privateRouting === true ? PRIVATE_ROUTES : []), ...(options.statsPage === true ? STATS_ROUTES : []), ...(options.tokenPage ? TOKEN_ROUTES : []), ...(options.testPages ? TEST_ROUTES : [])];
  if (!fs.existsSync(path.join(distDir, "index.html"))) return null;
  const assets = new Map<string, Asset>();
  for (const rel of walk(distDir)) {
    const ext = path.extname(rel).toLowerCase();
    const type = TYPES[ext];
    if (type === undefined) continue;
    let raw = fs.readFileSync(path.join(distDir, rel));
    // The first words before the share image's address: the address is written round whichever image the page then names.
    if (rel === "/index.html" && options.privateRouting === true) raw = Buffer.from(withPrivateRouting(raw.toString("utf8")), "utf8");
    if (rel === "/index.html" && options.statsPage === false) raw = Buffer.from(withoutStats(raw.toString("utf8")), "utf8");
    if (rel === "/index.html" && typeof options.rewardsWallet === "string") raw = Buffer.from(withRewardsWallet(raw.toString("utf8"), options.rewardsWallet), "utf8");
    if (rel === "/index.html" && typeof options.siteUrl === "string") raw = Buffer.from(withSiteUrl(raw.toString("utf8"), options.siteUrl), "utf8");
    if (rel === "/index.html" && options.banner !== undefined && options.banner.length > 0) raw = Buffer.from(withBanner(raw.toString("utf8"), options.banner), "utf8");
    const compress = COMPRESSIBLE.has(ext) && raw.length > 512;
    assets.set(rel, {
      type,
      raw,
      gzip: compress ? zlib.gzipSync(raw, { level: 9 }) : null,
      brotli: compress ? zlib.brotliCompressSync(raw) : null,
      etag: `"${createHash("sha256").update(raw).digest("base64url").slice(0, 22)}"`,
      immutable: rel.startsWith("/assets/"),
      // Coin and chain icons and the site icons rarely change: kept for a day, so that opening
      // the coin picker does not ask the server about dozens of images every time.
      daily: rel.startsWith("/coins/") || rel.startsWith("/chains/") || rel.startsWith("/brand/") || /^\/(favicon|apple-touch-icon|icon-|share)[^/]*$/.test(rel),
    });
  }
  const index = assets.get("/index.html");
  if (index === undefined) return null;

  // One copy of the page for each address that may be indexed, made the first time it is asked for.
  const pages = new Map<string, Asset>();
  function pageAt(pathname: string): Asset {
    if (typeof options.siteUrl !== "string" || index === undefined) return index!;
    let page = pages.get(pathname);
    if (page === undefined) {
      const raw = Buffer.from(withCanonical(index.raw.toString("utf8"), options.siteUrl, pathname), "utf8");
      page = { ...index, raw, gzip: zlib.gzipSync(raw, { level: 9 }), brotli: zlib.brotliCompressSync(raw), etag: `"${createHash("sha256").update(raw).digest("base64url").slice(0, 22)}"` };
      pages.set(pathname, page);
    }
    return page;
  }

  function send(req: IncomingMessage, res: ServerResponse, asset: Asset, status: number, headers: Record<string, string>): number {
    if (status === 200 && req.headers["if-none-match"] === asset.etag) {
      res.writeHead(304, { ETag: asset.etag, ...headers });
      res.end();
      return 304;
    }
    const accepts = String(req.headers["accept-encoding"] ?? "");
    let body = asset.raw;
    const extra: Record<string, string> = {};
    if (asset.brotli && /\bbr\b/.test(accepts)) {
      body = asset.brotli;
      extra["Content-Encoding"] = "br";
    } else if (asset.gzip && /\bgzip\b/.test(accepts)) {
      body = asset.gzip;
      extra["Content-Encoding"] = "gzip";
    }
    res.writeHead(status, {
      "Content-Type": asset.type,
      "Content-Length": String(body.length),
      ETag: asset.etag,
      Vary: "Accept-Encoding",
      ...extra,
      ...headers,
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return status;
  }

  return {
    scriptHashes: inlineScriptHashes(index.raw.toString("utf8")),
    handle(req, res, pathname) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD", "Content-Length": "0" });
        res.end();
        return 405;
      }
      const file = pathname === "/" ? undefined : assets.get(pathname);
      if (file !== undefined && pathname !== "/index.html") {
        return send(req, res, file, 200, {
          "Cache-Control": file.immutable ? "public, max-age=31536000, immutable" : file.daily ? "public, max-age=86400" : "no-cache",
        });
      }
      const known = routes.some((route) => route.test(pathname));
      const orderPage = pathname.startsWith("/order/");
      // Order pages are never cached and never indexed. Unknown paths get the same shell with a 404.
      return send(req, res, known && !orderPage ? pageAt(pathname) : index, known ? 200 : 404, {
        "Cache-Control": orderPage || !known ? "no-store" : "no-cache",
        ...(orderPage || !known ? { "X-Robots-Tag": "noindex" } : {}),
      });
    },
  };
}
