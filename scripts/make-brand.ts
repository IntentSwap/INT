// Makes every size of the logo and of the site's icons from the owner's two source files.
// Run it again when either source file changes; what it writes is committed.
//
//   npx tsx scripts/make-brand.ts
//
// The sources (web/src/assets/brand/) are the owner's artwork and are never changed:
//   logo-source.png   the mark on a transparent ground, for the site itself
//   icon-source.png   the mark on its own black square, for the browser tab and a phone's home screen
//
// What is written (web/public/):
//   brand/logo-<height>.webp   the mark at 24, 28 and 32 px high, each at 1x, 2x and 3x, transparency kept
//   favicon.ico                16, 32 and 48 px in one file
//   favicon-32.png, icon-192.png, icon-512.png, apple-touch-icon.png (180)
//   site.webmanifest           the name, the two large icons, and the page's colour from the design tokens
// and shared/brand.ts, which holds the logo's sizes for the page.
//
// Nothing is redrawn, recoloured or given an effect. Each picture is only scaled, with the empty
// ground round the mark trimmed first so that the mark fills the size it is shown at: the
// transparent margin of the logo, and part of the black margin of the icon (never the mark or the
// light round it). Uses the Chrome already installed on this machine, for its scaling and its
// encoders: no other tool is needed.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { chromium } from "playwright-core";

const SOURCES = path.resolve("web", "src", "assets", "brand");
const PUBLIC = path.resolve("web", "public");

/** The heights the mark is shown at, in CSS pixels. Each is made at one, two and three device pixels to the pixel. */
export const LOGO_HEIGHTS = [24, 28, 32] as const;
const DENSITIES = [1, 2, 3] as const;
/** How much of the mark's own size is left round it as air, on each side. */
const LOGO_AIR = 0.02;
const ICON_AIR = 0.14;
/** A pixel of the logo counts as part of the mark from this much opacity (of 255). */
const LOGO_INK = 8;
/** A pixel of the icon counts as the mark, or the light round it, from this much brightness (of 255). */
const ICON_LIGHT = 20;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Made {
  name: string;
  width: number;
  height: number;
  base64: string;
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext()).newPage();
await page.setContent("<!doctype html><title>brand</title>");

const dataUrl = (file: string) => `data:image/png;base64,${fs.readFileSync(path.join(SOURCES, file)).toString("base64")}`;

/** The size of a source picture, and the box round everything in it that is not empty ground. */
async function measure(file: string, mode: "alpha" | "light", threshold: number): Promise<{ width: number; height: number; box: Box }> {
  return page.evaluate(
    async ([url, how, limit]) => {
      const bitmap = await createImageBitmap(await (await fetch(url as string)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      let left = bitmap.width;
      let top = bitmap.height;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < bitmap.height; y++) {
        for (let x = 0; x < bitmap.width; x++) {
          const i = (y * bitmap.width + x) * 4;
          const lit = how === "alpha" ? data[i + 3]! >= (limit as number) : Math.max(data[i]!, data[i + 1]!, data[i + 2]!) >= (limit as number);
          if (!lit) continue;
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
      return { width: bitmap.width, height: bitmap.height, box: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } };
    },
    [dataUrl(file), mode, threshold] as const,
  );
}

/**
 * One part of a source picture, scaled to a size: as a WebP that loses nothing, or (for a PNG) as
 * its plain pixels, four bytes to each, which are then written as a PNG here (see pngOf).
 */
async function scaled(file: string, crop: Box, width: number, height: number, type: "image/webp" | "image/png", name: string): Promise<Made> {
  const base64 = await page.evaluate(
    async ([url, box, w, h, mime]) => {
      const part = box as { x: number; y: number; width: number; height: number };
      const blob = await (await fetch(url as string)).blob();
      const bitmap = await createImageBitmap(blob, part.x, part.y, part.width, part.height, { resizeWidth: w as number, resizeHeight: h as number, resizeQuality: "high" });
      const canvas = new OffscreenCanvas(w as number, h as number);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      // Quality 1 makes Chrome write a WebP that loses nothing.
      const bytes = mime === "image/webp" ? new Uint8Array(await (await canvas.convertToBlob({ type: "image/webp", quality: 1 })).arrayBuffer()) : new Uint8Array(context.getImageData(0, 0, w as number, h as number).data.buffer);
      let text = "";
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(text);
    },
    [dataUrl(file), crop, width, height, type] as const,
  );
  if (type === "image/webp") return { name, width, height, base64: withoutProfile(Buffer.from(base64, "base64")).toString("base64") };
  return { name, width, height, base64: pngOf(Buffer.from(base64, "base64"), width, height).toString("base64") };
}

/**
 * A WebP without the colour profile Chrome writes into it. The pixels are already in the web's own
 * colour space (the canvas they were drawn on is), which is what a browser takes a picture with no
 * profile to be in: so the profile says nothing, and is a third of a file this small.
 */
function withoutProfile(webp: Buffer): Buffer {
  if (webp.toString("latin1", 0, 4) !== "RIFF" || webp.toString("latin1", 8, 12) !== "WEBP") throw new Error("make-brand: not a WebP");
  const kept: Buffer[] = [];
  for (let at = 12; at + 8 <= webp.length; ) {
    const kind = webp.toString("latin1", at, at + 4);
    const size = webp.readUInt32LE(at + 4);
    const end = at + 8 + size + (size % 2);
    const chunk = Buffer.from(webp.subarray(at, end));
    // The first chunk lists what the file holds: the profile is struck from that list as it is from the file.
    if (kind === "VP8X") chunk[8] = chunk[8]! & ~0x20;
    if (kind !== "ICCP") kept.push(chunk);
    at = end;
  }
  const body = Buffer.concat(kept);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length + 4, 4);
  head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, body]);
}

/**
 * A PNG of plain pixels, written small: three bytes to a pixel where nothing is see-through (four
 * where something is), each row stored in whichever of the format's five ways comes out smallest,
 * and packed as tightly as the packer goes. Not one pixel is changed by any of it.
 */
function pngOf(rgba: Buffer, width: number, height: number): Buffer {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) opaque = false;
  const bpp = opaque ? 3 : 4;
  const stride = width * bpp;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) rgba.copy(row, x * bpp, (y * width + x) * 4, (y * width + x) * 4 + bpp);
    rows.push(row);
  }
  const none = Buffer.alloc(stride);
  const packed: Buffer[] = [];
  rows.forEach((row, y) => {
    const above = y === 0 ? none : rows[y - 1]!;
    let best: Buffer | null = null;
    let bestCost = Infinity;
    for (let filter = 0; filter < 5; filter++) {
      const line = Buffer.alloc(stride + 1);
      line[0] = filter;
      let cost = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? row[i - bpp]! : 0;
        const up = above[i]!;
        const upLeft = i >= bpp ? above[i - bpp]! : 0;
        let predicted = 0;
        if (filter === 1) predicted = left;
        else if (filter === 2) predicted = up;
        else if (filter === 3) predicted = (left + up) >> 1;
        else if (filter === 4) {
          const p = left + up - upLeft;
          const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
          predicted = a <= b && a <= c ? left : b <= c ? up : upLeft;
        }
        const value = (row[i]! - predicted) & 0xff;
        line[i + 1] = value;
        cost += value < 128 ? value : 256 - value;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = line;
      }
    }
    packed.push(best!);
  });
  const chunk = (kind: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(kind, "latin1"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.writeUInt8(8, 8);
  head.writeUInt8(opaque ? 2 : 6, 9);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", zlib.deflateSync(Buffer.concat(packed), { level: 9, memLevel: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** A box grown by a share of its own size on every side, kept inside the picture. */
function withAir(box: Box, air: number, width: number, height: number): Box {
  const pad = Math.round(Math.max(box.width, box.height) * air);
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  return { x, y, width: Math.min(width, box.x + box.width + pad) - x, height: Math.min(height, box.y + box.height + pad) - y };
}

/** The smallest square round a box, with air, centred on it and kept inside the picture. The whole picture when that is smaller. */
function squareRound(box: Box, air: number, width: number, height: number): Box {
  const side = Math.min(width, height, Math.round(Math.max(box.width, box.height) * (1 + 2 * air)));
  const x = Math.min(Math.max(0, Math.round(box.x + box.width / 2 - side / 2)), width - side);
  const y = Math.min(Math.max(0, Math.round(box.y + box.height / 2 - side / 2)), height - side);
  return { x, y, width: side, height: side };
}

// ---- The logo: the mark alone, its transparent margin trimmed ----
const logo = await measure("logo-source.png", "alpha", LOGO_INK);
const logoCrop = withAir(logo.box, LOGO_AIR, logo.width, logo.height);
const heights = [...new Set(LOGO_HEIGHTS.flatMap((height) => DENSITIES.map((density) => height * density)))].sort((a, b) => a - b);
const widthAt = (height: number) => Math.round((height * logoCrop.width) / logoCrop.height);
fs.mkdirSync(path.join(PUBLIC, "brand"), { recursive: true });
const logos: Made[] = [];
for (const height of heights) logos.push(await scaled("logo-source.png", logoCrop, widthAt(height), height, "image/webp", `brand/logo-${height}.webp`));

// ---- The icons: the mark on its black square, with less of the empty black round it ----
const icon = await measure("icon-source.png", "light", ICON_LIGHT);
const iconCrop = squareRound(icon.box, ICON_AIR, icon.width, icon.height);
const iconAt = (size: number, name: string) => scaled("icon-source.png", iconCrop, size, size, "image/png", name);
const icons = [await iconAt(32, "favicon-32.png"), await iconAt(180, "apple-touch-icon.png"), await iconAt(192, "icon-192.png"), await iconAt(512, "icon-512.png")];
const inIco = [await iconAt(16, "16"), await iconAt(32, "32"), await iconAt(48, "48")];
await browser.close();

for (const made of [...logos, ...icons]) fs.writeFileSync(path.join(PUBLIC, made.name), Buffer.from(made.base64, "base64"));

// favicon.ico: a small header, one line of 16 bytes for each picture, then the pictures themselves, each a PNG.
const pictures = inIco.map((made) => Buffer.from(made.base64, "base64"));
const header = Buffer.alloc(6 + 16 * pictures.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pictures.length, 4);
let offset = header.length;
inIco.forEach((made, index) => {
  const at = 6 + 16 * index;
  header.writeUInt8(made.width, at);
  header.writeUInt8(made.height, at + 1);
  header.writeUInt8(0, at + 2);
  header.writeUInt8(0, at + 3);
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(pictures[index]!.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += pictures[index]!.length;
});
fs.writeFileSync(path.join(PUBLIC, "favicon.ico"), Buffer.concat([header, ...pictures]));

// The manifest: the page's own colour, read from the design tokens (the dark theme's, which is the icon's own ground).
const tokens = fs.readFileSync(path.resolve("web", "src", "styles", "tokens.css"), "utf8");
const dark = /:root,\s*:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(tokens)?.[1] ?? "";
const pageColour = /--bg:\s*(#[0-9a-fA-F]{6});/.exec(dark)?.[1];
if (pageColour === undefined) throw new Error("make-brand: the page's colour (--bg) is not in the design tokens");
const manifest = {
  name: "IntentSwap",
  short_name: "IntentSwap",
  start_url: "/",
  display: "browser",
  theme_color: pageColour,
  background_color: pageColour,
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
};
fs.writeFileSync(path.join(PUBLIC, "site.webmanifest"), `${JSON.stringify(manifest, null, 2)}\n`);

// The sizes the page needs, so that the logo takes its place before it has loaded.
const sizes = LOGO_HEIGHTS.map((height) => `  ${height}: { width: ${widthAt(height)}, height: ${height} },`).join("\n");
fs.writeFileSync(
  path.resolve("shared", "brand.ts"),
  `// Written by scripts/make-brand.ts from the logo's source file. Do not edit by hand: run the script again.

/** The heights the logo is made for, in CSS pixels, each with the width that keeps its shape. */
export const LOGO_SIZES = {
${sizes}
} as const;

export type LogoHeight = keyof typeof LOGO_SIZES;

/** How many device pixels to a CSS pixel each height is made for. */
export const LOGO_DENSITIES = [${DENSITIES.join(", ")}] as const;

/** The address of the logo at a height and a density: the file is as many pixels high as the two multiplied. */
export function logoSrc(height: LogoHeight, density: (typeof LOGO_DENSITIES)[number] = 1): string {
  return \`/brand/logo-\${height * density}.webp\`;
}

/** The three files for one height, as a browser is told of them: it takes the one for its own screen. */
export function logoSrcSet(height: LogoHeight): string {
  return LOGO_DENSITIES.map((density) => \`\${logoSrc(height, density)} \${density}x\`).join(", ");
}
`,
);

const kb = (file: string) => `${(fs.statSync(path.join(PUBLIC, file)).size / 1024).toFixed(1)} KB`;
console.log(`make-brand: logo ${logo.width} x ${logo.height}, mark at ${JSON.stringify(logo.box)}, cut to ${JSON.stringify(logoCrop)}`);
for (const made of logos) console.log(`  ${made.name}  ${made.width} x ${made.height}  ${kb(made.name)}`);
console.log(`make-brand: icon ${icon.width} x ${icon.height}, mark and its light at ${JSON.stringify(icon.box)}, cut to ${JSON.stringify(iconCrop)}`);
for (const made of icons) console.log(`  ${made.name}  ${made.width} x ${made.height}  ${kb(made.name)}`);
console.log(`  favicon.ico  ${inIco.map((made) => made.width).join(", ")}  ${kb("favicon.ico")}`);
console.log(`  site.webmanifest  ${pageColour}`);
