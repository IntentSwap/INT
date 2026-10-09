import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUDGETS, checkBuild } from "../scripts/check-build.ts";
import { firstWords } from "../server/static.ts";

/** The start of every sample page: the first words of the site in the form the server may rewrite them, as the real page holds them. */
const FIRST = `<!doctype html>${firstWords("public").map((place) => place.html).join("")}`;

let dist = "";
beforeEach(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-dist-"));
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(path.join(dist, "index.html"), FIRST + '<script type="module" src="/assets/app-1.js"></script><link rel="stylesheet" href="/assets/app-1.css">');
  fs.writeFileSync(path.join(dist, "assets", "app-1.js"), 'console.log("hello")');
  fs.writeFileSync(path.join(dist, "assets", "app-1.css"), "body{margin:0}");
});
afterEach(() => fs.rmSync(dist, { recursive: true, force: true }));

const add = (name: string, content: string | Buffer) => fs.writeFileSync(path.join(dist, "assets", name), content);
const problems = (env: Record<string, string> = {}) => checkBuild(dist, env).problems;

describe("build check", () => {
  it("fails when the built page no longer holds one of the first words the server rewrites for a privately routed site, or holds it twice", () => {
    const page = fs.readFileSync(path.join(dist, "index.html"), "utf8");
    fs.writeFileSync(path.join(dist, "index.html"), page.replace("<title>IntentSwap</title>", "<title>IntentSwap </title>"));
    expect(problems()).toEqual(["index.html holds the title 0 times in the form the server rewrites (it must be there exactly once)"]);
    fs.writeFileSync(path.join(dist, "index.html"), `${page}<title>IntentSwap</title>`);
    expect(problems()).toEqual(["index.html holds the title 2 times in the form the server rewrites (it must be there exactly once)"]);
  });

  it("passes a clean build and reports its sizes", () => {
    const report = checkBuild(dist, {});
    expect(report.problems).toEqual([]);
    expect(report.sizes.script).toBeGreaterThan(0);
    expect(report.sizes.css).toBeGreaterThan(0);
    expect(report.sizes.fonts).toBe(0);
  });

  it("fails when there is no build", () => {
    expect(checkBuild(path.join(dist, "missing"), {}).problems).toEqual(["index.html is missing"]);
  });

  it("fails when the value of a server-only variable is in the output", () => {
    add("leak.js", 'fetch("https://rpc.example/v2/abcdef123456")');
    for (const name of ["ONECLICK_API_KEY", "ALERT_WEBHOOK_URL", "BSC_RPC_URL", "ETH_RPC_URL", "BASE_RPC_URL", "ARBITRUM_RPC_URL", "SOLANA_RPC_URL", "FEE_RECIPIENT"]) {
      expect(problems({ [name]: "https://rpc.example/v2/abcdef123456" }), name).toEqual(["assets/leak.js: contains the value of a server-only variable"]);
    }
    // A public value, such as the wallet-connect project ID, is not a leak.
    expect(problems({ REOWN_PROJECT_ID: "https://rpc.example/v2/abcdef123456" })).toEqual([]);
  });

  const leaks: Array<[string, string, string]> = [
    ["a signed token", `const t="eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwYXJ0bmVyIn0.c2lnbmF0dXJlLXZhbHVl"`, "a signed token"],
    ["a private key", "-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----", "a private key"],
    ["the name of a server-only variable", "process.env.ONECLICK_API_KEY", "the name of a server-only variable"],
    // Built from pieces so this file itself never contains a machine path.
    ["a path from a Mac", `at "${["", "Users", "someone", "project", "x.ts"].join("/")}"`, "a path from the build machine"],
    ["a path from Linux", `at "${["", "home", "runner", "work", "x.ts"].join("/")}"`, "a path from the build machine"],
    ["the provider key header", 'headers:{"X-API-Key":k}', "the provider key header"],
    ["the provider's address", 'fetch("https://1click.chaindefuser.com/v0/quote")', "the provider's address (the browser must never call it)"],
    ["a wallet kit that is left out", 'const url="https://keys.coinbase.com/connect"', "a wallet kit this site leaves out (see web/vite.config.ts)"],
  ];
  it.each(leaks)("fails when the output contains %s", (_label, content, what) => {
    add("leak.js", content);
    expect(problems()).toEqual([`assets/leak.js: contains ${what}`]);
  });

  it("counts styles written into the page toward the CSS budget", () => {
    const before = checkBuild(dist, {}).sizes.css;
    const page = fs.readFileSync(path.join(dist, "index.html"), "utf8");
    fs.writeFileSync(path.join(dist, "index.html"), `${page}<style>.a{color:red}.b{color:blue}</style>`);
    expect(checkBuild(dist, {}).sizes.css).toBeGreaterThan(before);
  });

  it("does not count the first screen's styles twice when they are in the page and in the file the page names", () => {
    const css = fs.readFileSync(path.join(dist, "assets", "app-1.css"), "utf8");
    const once = checkBuild(dist, {}).sizes.css;
    fs.writeFileSync(path.join(dist, "index.html"), `${FIRST}<script type="module" src="/assets/app-1.js"></script><style>${css}</style><link rel="stylesheet" crossorigin href="/assets/app-1.css" media="not all">`);
    const report = checkBuild(dist, {});
    expect(report.problems).toEqual([]);
    expect(report.sizes.css).toBe(once);
  });

  it("fails when a script of the build needs a stylesheet that is not in the build", () => {
    // What went wrong once: the first screen's stylesheet was folded into the page and its file removed,
    // while code fetched later still listed the file among what it needs.
    add("wallet-1.js", 'const deps=["assets/app-1.js","assets/gone-1.css"];');
    expect(problems()).toEqual(["assets/wallet-1.js: needs assets/gone-1.css, which is not in the build"]);
    add("gone-1.css", ".a{color:red}");
    expect(problems()).toEqual([]);
  });

  it("fails when the page names a stylesheet that is not in the build", () => {
    fs.writeFileSync(path.join(dist, "index.html"), FIRST + '<script type="module" src="/assets/app-1.js"></script><style>body{margin:0}</style><link rel="stylesheet" crossorigin href="/assets/app-9.css" media="not all">');
    expect(problems()).toEqual(["index.html names assets/app-9.css, which is not in the build"]);
  });

  it("fails on a file at the top of the build that the site is not known to publish", () => {
    for (const known of ["favicon.ico", "favicon-32.png", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "site.webmanifest", "share.png", "share-private.png"]) fs.writeFileSync(path.join(dist, known), known.endsWith(".webmanifest") ? "{}" : "x");
    fs.mkdirSync(path.join(dist, "coins"));
    fs.mkdirSync(path.join(dist, "chains"));
    fs.mkdirSync(path.join(dist, "brand"));
    expect(problems()).toEqual([]);
    fs.writeFileSync(path.join(dist, "ETH-branded.svg"), "<svg/>");
    expect(problems()).toEqual(["ETH-branded.svg: not a file this site is known to publish (remove it from web/public, or add it to the list in scripts/check-build.ts)"]);
  });

  it("fails when an icon of the page, or of its manifest, is not a file of the build or is at another address", () => {
    const head = '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" /><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" /><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" /><link rel="manifest" href="/site.webmanifest" />';
    const page = (links: string) => fs.writeFileSync(path.join(dist, "index.html"), FIRST + links + '<script type="module" src="/assets/app-1.js"></script>');
    const manifest = (icons: unknown) => fs.writeFileSync(path.join(dist, "site.webmanifest"), JSON.stringify({ name: "IntentSwap", icons }));
    page(head);
    for (const file of ["favicon.ico", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png"]) fs.writeFileSync(path.join(dist, file), "x");
    manifest([{ src: "/icon-192.png" }, { src: "/icon-512.png" }]);
    expect(problems()).toEqual([]);
    // One of the page's icons is missing from the build.
    fs.rmSync(path.join(dist, "favicon.ico"));
    expect(problems()).toEqual(["index.html names favicon.ico, which is not in the build"]);
    fs.writeFileSync(path.join(dist, "favicon.ico"), "x");
    // One of the manifest's is.
    fs.rmSync(path.join(dist, "icon-512.png"));
    expect(problems()).toEqual(["site.webmanifest names icon-512.png, which is not in the build"]);
    fs.writeFileSync(path.join(dist, "icon-512.png"), "x");
    // An icon fetched from anywhere but this site is refused, however its address is written.
    for (const outside of ["https://example.com/icon.png", "//example.com/icon.png", "icon.png", ""]) {
      manifest([{ src: outside }]);
      expect(problems(), outside).toEqual([`site.webmanifest names the icon "${outside}", which is not an address of this site`]);
    }
    manifest([{ src: "/icon-192.png" }]);
    page(head.replace("/favicon-32.png", "https://example.com/favicon-32.png"));
    expect(problems()).toEqual(['index.html names the icon "https://example.com/favicon-32.png", which is not an address of this site']);
    // The address the logo's source files were fetched from is never in what is published.
    page(head + "<!-- imagedelivery.net/abc/public -->");
    expect(problems()).toEqual(["index.html: contains the outside address the logo's source files came from (the site serves its own copies)"]);
    // A manifest that cannot be read is said so.
    page(head);
    fs.writeFileSync(path.join(dist, "site.webmanifest"), "{ not json");
    expect(problems()).toEqual(["site.webmanifest: is not valid JSON"]);
  });

  it("fails when NEAR's own mark is among the coin or chain icons", () => {
    fs.mkdirSync(path.join(dist, "coins"));
    fs.mkdirSync(path.join(dist, "chains"));
    fs.writeFileSync(path.join(dist, "coins", "aurora.svg"), "<svg/>");
    expect(problems()).toEqual([]);
    fs.writeFileSync(path.join(dist, "coins", "near.svg"), "<svg/>");
    fs.writeFileSync(path.join(dist, "chains", "near-protocol.svg"), "<svg/>");
    expect(problems().sort()).toEqual([`${path.join("chains", "near-protocol.svg")}: NEAR's own mark is not used on this site`, `${path.join("coins", "near.svg")}: NEAR's own mark is not used on this site`]);
  });

  it("fails when wallet code is part of the first page load, and not when it is in a file fetched later", () => {
    add("wallet-1.js", 'new WebSocket("wss://relay.walletconnect.org")');
    expect(problems()).toEqual([]);
    fs.writeFileSync(path.join(dist, "assets", "app-1.js"), 'new WebSocket("wss://relay.walletconnect.org")');
    expect(problems()).toEqual(["assets/app-1.js: wallet code is part of the first page load (it must load only when Connect is pressed)"]);
  });

  it("fails on a source map", () => {
    add("app-1.js.map", "{}");
    expect(problems()).toEqual(["assets/app-1.js.map: source maps are not shipped"]);
  });

  it("fails when a size budget is broken", () => {
    // Random bytes do not compress, so each file is as large on the wire as on disk.
    const random = (bytes: number) => Buffer.from(Array.from({ length: bytes }, () => 33 + Math.floor(Math.random() * 90)));
    add("app-1.js", random(BUDGETS.script * 2));
    expect(problems().some((p) => p.startsWith("initial JavaScript (gzip) is"))).toBe(true);
    add("app-1.js", 'console.log("hello")');
    add("app-1.css", random(BUDGETS.css * 2));
    expect(problems().some((p) => p.startsWith("CSS (gzip) is"))).toBe(true);
    add("app-1.css", "body{margin:0}");
    add("big.woff2", random(BUDGETS.fonts + 1));
    expect(problems()).toEqual(["fonts is 117.2 KB, over the 120 KB budget"].map((p) => p.replace("117.2", ((BUDGETS.fonts + 1) / 1024).toFixed(1))));
  });

  it("counts only the scripts the first page load fetches", () => {
    const lazy = Buffer.from(Array.from({ length: BUDGETS.script * 2 }, () => 33 + Math.floor(Math.random() * 90)));
    add("wallet-lazy.js", lazy);
    expect(problems()).toEqual([]);
  });

  it("fails when the page refers to a script that was not built", () => {
    fs.rmSync(path.join(dist, "assets", "app-1.js"));
    expect(problems()).toEqual(["index.html refers to /assets/app-1.js, which is not in the build"]);
  });
});
