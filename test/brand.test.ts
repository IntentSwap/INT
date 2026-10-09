// The owner's logo and the site's icons: the artwork is
// kept as it was supplied, every size the site shows is made from it and served by the site itself,
// and the two-arrow drawing it replaces is gone.

import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { requestPath, securityHeaders } from "../server/http.ts";
import { loadStaticSite } from "../server/static.ts";
import { LOGO_DENSITIES, LOGO_SIZES, logoSrc, logoSrcSet } from "../shared/brand.ts";
import { Mark, Wordmark } from "../web/src/components/Brand.tsx";

const PUBLIC = path.resolve("web", "public");
const SOURCES = path.resolve("web", "src", "assets", "brand");
const file = (name: string) => fs.readFileSync(path.join(PUBLIC, name));

/** The size of a PNG and whether any of it can be see-through, from its first chunk. */
function pngHead(png: Buffer): { width: number; height: number; alpha: boolean } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), alpha: png[25] === 4 || png[25] === 6 };
}

/** The pixels of a PNG with three bytes to a pixel, as this project writes its icons. */
function pngPixels(png: Buffer): { width: number; height: number; at(x: number, y: number): [number, number, number] } {
  const { width, height } = pngHead(png);
  expect([png[24], png[25]]).toEqual([8, 2]);
  const data: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const size = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") data.push(png.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * 3;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const left = i >= 3 ? out[y * stride + i - 3]! : 0;
      const up = y > 0 ? out[(y - 1) * stride + i]! : 0;
      const upLeft = y > 0 && i >= 3 ? out[(y - 1) * stride + i - 3]! : 0;
      const p = left + up - upLeft;
      const paeth = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - upLeft) ? left : Math.abs(p - up) <= Math.abs(p - upLeft) ? up : upLeft;
      const predicted = [0, left, up, (left + up) >> 1, paeth][filter]!;
      out[y * stride + i] = (raw[y * (stride + 1) + 1 + i]! + predicted) & 0xff;
    }
  }
  return { width, height, at: (x, y) => [out[y * stride + x * 3]!, out[y * stride + x * 3 + 1]!, out[y * stride + x * 3 + 2]!] };
}

/** The size of a WebP, whether it keeps transparency, and whether it carries a colour profile. */
function webpHead(webp: Buffer): { width: number; height: number; alpha: boolean; profile: boolean } {
  expect(webp.toString("latin1", 0, 4)).toBe("RIFF");
  expect(webp.toString("latin1", 8, 16)).toBe("WEBPVP8X");
  expect(webp.readUInt32LE(4)).toBe(webp.length - 8);
  return { width: webp.readUIntLE(24, 3) + 1, height: webp.readUIntLE(27, 3) + 1, alpha: (webp[20]! & 0x10) !== 0, profile: (webp[20]! & 0x20) !== 0 || webp.includes("ICCP") };
}

describe("the owner's artwork", () => {
  it("is kept in the project as it was supplied: the two source files, unchanged", () => {
    const print = (name: string) => createHash("sha256").update(fs.readFileSync(path.join(SOURCES, name))).digest("hex");
    expect(fs.readdirSync(SOURCES).sort()).toEqual(["icon-source.png", "logo-source.png"]);
    expect(print("logo-source.png")).toBe("841f258e77d0c935438e5d630987e7e11e57cb2e0fb48be93692e1791f04dd07");
    expect(print("icon-source.png")).toBe("6dd29059b2f264b95e3da5a571c50e8e7e52a36460cb92b60aee23f2ca23079b");
    // The logo is on a transparent ground (a list of colours, some of them see-through); the icon is a square of its own, with none.
    const [logo, icon] = ["logo-source.png", "icon-source.png"].map((name) => fs.readFileSync(path.join(SOURCES, name))) as [Buffer, Buffer];
    expect(pngHead(logo)).toMatchObject({ width: 500, height: 500 });
    expect(pngHead(icon)).toMatchObject({ width: 500, height: 500 });
    expect([logo.includes("tRNS"), icon.includes("tRNS")]).toEqual([true, false]);
  });

  it("is only scaled by the script that makes the sizes: nothing in it recolours, redraws or adds an effect", () => {
    const script = fs.readFileSync(path.resolve("scripts", "make-brand.ts"), "utf8");
    for (const never of [/\.filter\s*=/, /globalCompositeOperation/, /shadowBlur|shadowColor/, /fillStyle|strokeStyle|fillRect|fillText/, /putImageData/, /hue-rotate|invert\(|brightness\(|contrast\(|saturate\(/]) expect(script, String(never)).not.toMatch(never);
    expect(script).toMatch(/createImageBitmap\(blob, part\.x, part\.y, part\.width, part\.height, \{ resizeWidth: w as number, resizeHeight: h as number, resizeQuality: "high" \}\)/);
  });
});

describe("the logo on the site", () => {
  it("is made at 24, 28 and 32 px high, each for one, two and three device pixels, with transparency kept and no needless weight", () => {
    expect(Object.keys(LOGO_SIZES).map(Number)).toEqual([24, 28, 32]);
    expect([...LOGO_DENSITIES]).toEqual([1, 2, 3]);
    const heights = [24, 28, 32].flatMap((height) => [1, 2, 3].map((density) => height * density));
    expect(fs.readdirSync(path.join(PUBLIC, "brand")).sort()).toEqual([...new Set(heights)].map((height) => `logo-${height}.webp`).sort());
    for (const [height, { width }] of Object.entries(LOGO_SIZES)) {
      for (const density of LOGO_DENSITIES) {
        const src = logoSrc(Number(height) as 24, density);
        expect(src).toBe(`/brand/logo-${Number(height) * density}.webp`);
        const head = webpHead(file(src));
        // To the pixel: the shape the page reserves is the shape of the file.
        expect(head).toEqual({ width: width * density, height: Number(height) * density, alpha: true, profile: false });
        expect(file(src).length).toBeLessThan(8 * 1024);
      }
    }
    expect(logoSrcSet(28)).toBe("/brand/logo-28.webp 1x, /brand/logo-56.webp 2x, /brand/logo-84.webp 3x");
  });

  it("stands beside the name, links home, reads IntentSwap, and has its size set so nothing moves when it loads", () => {
    // (Drawn outside a browser, a picture comes with a hint to fetch it early; the page itself is drawn in the browser, which adds none.)
    const drawn = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element).replace(/<link rel="preload"[^>]*>/g, "");
    expect(drawn(createElement(Mark))).toBe('<img class="mark" src="/brand/logo-28.webp" srcSet="/brand/logo-28.webp 1x, /brand/logo-56.webp 2x, /brand/logo-84.webp 3x" width="28" height="28" alt="IntentSwap" decoding="async"/>');
    // 24 px on a phone, 28 from 768 px: each with the three files for its own height.
    expect(drawn(createElement(Wordmark))).toBe(
      '<a class="wordmark" href="/" aria-label="IntentSwap, home"><picture><source media="(min-width: 768px)" srcSet="/brand/logo-28.webp 1x, /brand/logo-56.webp 2x, /brand/logo-84.webp 3x" width="28" height="28"/>' +
        '<img class="mark" src="/brand/logo-24.webp" srcSet="/brand/logo-24.webp 1x, /brand/logo-48.webp 2x, /brand/logo-72.webp 3x" width="24" height="24" alt="IntentSwap" decoding="async"/></picture><span class="wordmark-text">IntentSwap</span></a>',
    );
  });

  it("is the one mark in the header and the footer of every page, and the two-arrow drawing is gone from the project", () => {
    const shell = fs.readFileSync(path.resolve("web", "src", "components", "Shell.tsx"), "utf8");
    expect(shell.match(/<Wordmark \/>/g)).toHaveLength(2);
    // One header and one footer for every page: the Docs, the Terms and the Privacy Policy have no other.
    const app = fs.readFileSync(path.resolve("web", "src", "App.tsx"), "utf8");
    expect(app).toMatch(/<Header \/>/);
    expect(app.match(/<Footer \/>/g)?.length).toBeGreaterThanOrEqual(1);
    const everything = ["web/src", "web/index.html", "web/public", "server", "shared", "scripts"].flatMap((root) => {
      const full = path.resolve(root);
      return fs.statSync(full).isDirectory() ? (fs.readdirSync(full, { recursive: true }) as string[]).map((name) => path.join(full, name)).filter((name) => fs.statSync(name).isFile()) : [full];
    });
    expect(everything.length).toBeGreaterThan(150);
    for (const name of everything) {
      expect(path.basename(name), name).not.toMatch(/^favicon-(dark|light)\.svg$|^make-icons\.ts$/);
      if (!/\.(tsx?|css|html|json|webmanifest|svg|mjs)$/.test(name)) continue;
      const text = fs.readFileSync(name, "utf8");
      // The old drawing's two strokes, and its favicons by name.
      expect(text, name).not.toMatch(/M7 8h13|M17 16H4|favicon-dark|favicon-light/);
      // The address the source files were fetched from is nowhere in what is built or run.
      expect(text, name).not.toMatch(new RegExp(["image", "delivery", "\\.net"].join(""), "i"));
    }
  });
});

describe("the favicon, the home-screen icons and the manifest", () => {
  it("favicon.ico holds 16, 32 and 48 px, and the PNG icons are 32, 180, 192 and 512 px", () => {
    const ico = file("favicon.ico");
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 3]);
    const inside = [0, 1, 2].map((index) => {
      const at = 6 + 16 * index;
      const picture = ico.subarray(ico.readUInt32LE(at + 12), ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8));
      expect(pngHead(picture)).toEqual({ width: ico[at]!, height: ico[at + 1]!, alpha: false });
      return ico[at];
    });
    expect(inside).toEqual([16, 32, 48]);
    for (const [name, size] of [["favicon-32.png", 32], ["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512]] as const) expect(pngHead(file(name)), name).toEqual({ width: size, height: size, alpha: false });
  });

  it("the mark fills the small square and is not cut: its light stops short of every edge, and it spans most of the width", () => {
    for (const name of ["favicon-32.png", "icon-192.png"]) {
      const { width, height, at } = pngPixels(file(name));
      const lit = (x: number, y: number) => Math.max(...at(x, y)) >= 40;
      for (let i = 0; i < width; i++) for (const [x, y] of [[i, 0], [i, height - 1], [0, i], [width - 1, i]] as const) expect(lit(x, y), `${name} ${x},${y}`).toBe(false);
      const columns = [...Array(width).keys()].filter((x) => [...Array(height).keys()].some((y) => lit(x, y)));
      expect((columns.at(-1)! - columns[0]! + 1) / width, name).toBeGreaterThan(0.68);
    }
  });

  it("the manifest names the site, its two large icons, and the page's own colour from the design tokens", () => {
    const tokens = fs.readFileSync(path.resolve("web", "src", "styles", "tokens.css"), "utf8");
    const page = /:root\[data-theme="dark"\] \{[\s\S]*?--bg: (#[0-9a-f]{6});/.exec(tokens)?.[1];
    expect(page).toBe("#0a0b0d");
    expect(JSON.parse(file("site.webmanifest").toString("utf8"))).toEqual({
      name: "IntentSwap",
      short_name: "IntentSwap",
      start_url: "/",
      display: "browser",
      theme_color: page,
      background_color: page,
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    });
  });

  it("the page's head names them, one favicon for both themes, and nothing at another address", () => {
    const html = fs.readFileSync(path.resolve("web", "index.html"), "utf8");
    const links = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*>/g)].map((match) => match[0]);
    expect(links).toEqual([
      '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />',
      '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />',
      '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />',
      '<link rel="manifest" href="/site.webmanifest" />',
    ]);
    expect(html).not.toMatch(/prefers-color-scheme[^>]*favicon|image\/svg\+xml/);
    for (const address of html.matchAll(/(?:href|src|content)="([a-z]+:)?\/\/[^"]*"/g)) expect(address[0]).toBe("");
  });

  it("the site itself serves every one of them, each as what it is, and its content-security policy is as it was", async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-brand-"));
    fs.cpSync(PUBLIC, dist, { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>");
    const site = loadStaticSite(dist)!;
    const server = http.createServer((req, res) => void site.handle(req, res, requestPath(req) ?? "/"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const wanted: [string, string][] = [
        ["/favicon.ico", "image/x-icon"],
        ["/favicon-32.png", "image/png"],
        ["/apple-touch-icon.png", "image/png"],
        ["/icon-192.png", "image/png"],
        ["/icon-512.png", "image/png"],
        ["/site.webmanifest", "application/manifest+json; charset=utf-8"],
        ...fs.readdirSync(path.join(PUBLIC, "brand")).map((name): [string, string] => [`/brand/${name}`, "image/webp"]),
      ];
      expect(wanted).toHaveLength(15);
      for (const [address, type] of wanted) {
        const reply = await fetch(base + address);
        expect(reply.status, address).toBe(200);
        expect(reply.headers.get("content-type"), address).toBe(type);
        expect(Buffer.from(await reply.arrayBuffer()).equals(file(address)), address).toBe(true);
        // Pictures are kept for a day; the manifest is asked for afresh.
        expect(reply.headers.get("cache-control"), address).toBe(address.endsWith(".webmanifest") ? "no-cache" : "public, max-age=86400");
      }
    } finally {
      server.close();
      fs.rmSync(dist, { recursive: true, force: true });
    }
    // Pictures and the manifest come from this site only: the policy that says so was not touched for the logo.
    const policy = securityHeaders({ scriptHashes: [] })["Content-Security-Policy"] ?? "";
    expect(policy).toContain("img-src 'self' data: blob:");
    expect(policy).toContain("manifest-src 'self'");
    expect(policy).not.toMatch(/https?:\/\/[^ ;]*(image|cdn)/i);
  });
});
