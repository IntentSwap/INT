// Fails the build when the output:
//   - contains anything that looks like a secret, the name or value of a server-only variable, a
//     path from the build machine, the provider's address, or a wallet kit this site leaves out;
//   - holds a file at its top level that this site is not known to publish, a source map, or
//     NEAR's own mark;
//   - names a script or a stylesheet that is not in the build;
//   - has wallet code in the first page load;
//   - breaks a size budget.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { firstWords } from "../server/static.ts";

/** Server-only variables. Their values must never reach the browser bundle. */
export const SERVER_ONLY = [
  "ONECLICK_API_KEY",
  "ALERT_WEBHOOK_URL",
  "BSC_RPC_URL",
  "ETH_RPC_URL",
  "BASE_RPC_URL",
  "ARBITRUM_RPC_URL",
  "SOLANA_RPC_URL",
  "FEE_RECIPIENT",
] as const;

const PATTERNS: Array<[RegExp, string]> = [
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a signed token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\b(ONECLICK_API_KEY|ALERT_WEBHOOK_URL|FEE_RECIPIENT|DATA_DIR|TRUST_PROXY_HOPS)\b/, "the name of a server-only variable"],
  [/\/(Users|home)\/[A-Za-z0-9._-]+\//, "a path from the build machine"],
  [/x-api-key/i, "the provider key header"],
  [/1click\.chaindefuser\.com/, "the provider's address (the browser must never call it)"],
  [/keys\.coinbase\.com|walletlink\.org|cca-lite\.coinbase\.com/, "a wallet kit this site leaves out (see web/vite.config.ts)"],
  [/imagedelivery\.net/i, "the outside address the logo's source files came from (the site serves its own copies)"],
];

/** Marks of the wallet code. None of it may be part of what the first page load fetches. */
const WALLET_CODE = /walletconnect\.org|web3modal\.org|w3m-modal/;

/**
 * Everything the top of the build may hold. Whatever is in web/public is served to anyone who asks
 * for it, so a file dropped there by mistake is published: the build fails on one it does not know.
 */
export const TOP_LEVEL = new Set(["index.html", "assets", "coins", "chains", "brand", "favicon.ico", "favicon-32.png", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "site.webmanifest", "share.png", "share-private.png"]);

/** NEAR's own mark is not used anywhere on the site: NEAR is shown as two letters, like any coin without artwork. */
const NEAR_ARTWORK = /^(coins|chains)\/[^/]*near[^/]*$/i;

const TEXT = new Set([".html", ".js", ".css", ".json", ".svg", ".txt", ".webmanifest", ".map"]);
const KB = 1024;

export const BUDGETS = { script: 200 * KB, css: 30 * KB, fonts: 120 * KB } as const;

export interface BuildReport {
  problems: string[];
  sizes: { script: number; css: number; fonts: number };
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

export function checkBuild(dist: string, env: Record<string, string | undefined>): BuildReport {
  const problems: string[] = [];
  const sizes = { script: 0, css: 0, fonts: 0 };
  const index = path.join(dist, "index.html");
  if (!fs.existsSync(index)) return { problems: ["index.html is missing"], sizes };

  for (const name of fs.readdirSync(dist)) {
    if (!TOP_LEVEL.has(name)) problems.push(`${name}: not a file this site is known to publish (remove it from web/public, or add it to the list in scripts/check-build.ts)`);
  }

  // The page's icons and its manifest are files of this build, and so are the icons the manifest
  // names: the site serves its own, and asks no other address for any of them.
  const icons = [...fs.readFileSync(index, "utf8").matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*href="([^"]*)"/g)].map((link): [string, string] => ["index.html", link[1] ?? ""]);
  const manifestFile = path.join(dist, "site.webmanifest");
  if (fs.existsSync(manifestFile)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { icons?: Array<{ src?: unknown }> };
      for (const icon of manifest.icons ?? []) icons.push(["site.webmanifest", typeof icon.src === "string" ? icon.src : ""]);
    } catch {
      problems.push("site.webmanifest: is not valid JSON");
    }
  }
  for (const [where, href] of icons) {
    if (!/^\/[^/]/.test(href)) problems.push(`${where} names the icon "${href}", which is not an address of this site`);
    else if (!fs.existsSync(path.join(dist, href))) problems.push(`${where} names ${href.slice(1)}, which is not in the build`);
  }

  const secretValues = SERVER_ONLY.map((name) => env[name]).filter((value): value is string => typeof value === "string" && value.length >= 8);

  for (const file of walk(dist)) {
    const ext = path.extname(file).toLowerCase();
    const rel = path.relative(dist, file);
    const raw = fs.readFileSync(file);
    if (ext === ".map") problems.push(`${rel}: source maps are not shipped`);
    if (NEAR_ARTWORK.test(rel.split(path.sep).join("/"))) problems.push(`${rel}: NEAR's own mark is not used on this site`);
    if (ext === ".woff2") sizes.fonts += raw.length;
    if (!TEXT.has(ext)) continue;
    const text = raw.toString("utf8");
    for (const [pattern, what] of PATTERNS) if (pattern.test(text)) problems.push(`${rel}: contains ${what}`);
    for (const value of secretValues) if (text.includes(value)) problems.push(`${rel}: contains the value of a server-only variable`);
    if (ext === ".css") sizes.css += zlib.gzipSync(raw, { level: 9 }).length;
  }

  // Only what the first page load fetches counts toward the script budget.
  const html = fs.readFileSync(index, "utf8");
  // Styles written into the page itself count toward the CSS budget like any stylesheet. The first
  // screen's styles are in the page AND in a file that the page names but never applies (see
  // web/vite.config.ts): that file is the same styles a second time and is not counted twice.
  const named = [...html.matchAll(/<link rel="stylesheet"[^>]*href="\/(assets\/[^"]+\.css)"[^>]*>/g)];
  for (const style of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    const inline = (style[1] ?? "").trim();
    const twin = named.find((link) => fs.existsSync(path.join(dist, link[1] ?? "")) && fs.readFileSync(path.join(dist, link[1] ?? ""), "utf8").trim() === inline);
    if (twin === undefined) sizes.css += zlib.gzipSync(Buffer.from(inline, "utf8"), { level: 9 }).length;
  }
  // Every stylesheet a script of the build lists as needed, and every one the page names, must be
  // a file of the build: otherwise code fetched later goes looking for it and fails.
  for (const file of walk(dist).filter((name) => name.endsWith(".js"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const dep of new Set([...text.matchAll(/"(assets\/[^"]+\.css)"/g)].map((m) => m[1] ?? ""))) {
      if (!fs.existsSync(path.join(dist, dep))) problems.push(`${path.relative(dist, file)}: needs ${dep}, which is not in the build`);
    }
  }
  for (const link of named) {
    if (!fs.existsSync(path.join(dist, link[1] ?? ""))) problems.push(`index.html names ${link[1]}, which is not in the build`);
  }
  // Where swaps are routed privately, the server writes the private first words into this page in
  // place of the public ones (server/static.ts). It can only do that if the built page still holds
  // each of the public ones, exactly, once: a build step that reworded or reordered any of them
  // would leave a private site saying the public words, and nothing else would notice.
  for (const place of firstWords("public")) {
    const found = html.split(place.html).length - 1;
    if (found !== 1) problems.push(`index.html holds ${place.what} ${found} times in the form the server rewrites (it must be there exactly once)`);
  }
  const initial = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1] ?? "");
  for (const src of new Set(initial)) {
    const file = path.join(dist, src);
    if (!fs.existsSync(file)) {
      problems.push(`index.html refers to ${src}, which is not in the build`);
      continue;
    }
    const raw = fs.readFileSync(file);
    sizes.script += zlib.gzipSync(raw, { level: 9 }).length;
    if (WALLET_CODE.test(raw.toString("utf8"))) problems.push(`${src.slice(1)}: wallet code is part of the first page load (it must load only when Connect is pressed)`);
  }

  const labels: Array<[string, number, number]> = [
    ["initial JavaScript (gzip)", sizes.script, BUDGETS.script],
    ["CSS (gzip)", sizes.css, BUDGETS.css],
    ["fonts", sizes.fonts, BUDGETS.fonts],
  ];
  for (const [label, size, limit] of labels) {
    if (size > limit) problems.push(`${label} is ${(size / KB).toFixed(1)} KB, over the ${limit / KB} KB budget`);
  }
  return { problems, sizes };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { problems, sizes } = checkBuild(path.resolve("web", "dist"), process.env);
  console.log(`check-build: initial JavaScript (gzip): ${(sizes.script / KB).toFixed(1)} KB of ${BUDGETS.script / KB} KB`);
  console.log(`check-build: CSS (gzip): ${(sizes.css / KB).toFixed(1)} KB of ${BUDGETS.css / KB} KB`);
  console.log(`check-build: fonts: ${(sizes.fonts / KB).toFixed(1)} KB of ${BUDGETS.fonts / KB} KB`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`check-build: ${problem}`);
    process.exit(1);
  }
  console.log("check-build: ok");
}
