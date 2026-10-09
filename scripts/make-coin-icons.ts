// Makes the coin and chain icons the site publishes from the logo files kept as sources.
// Run it again when a source file is added or changed; what it writes is committed.
//
//   npx tsx scripts/make-coin-icons.ts
//
// The sources are pictures fetched once from an open collection of token logos (see "Credits" in
// the README) and are never changed:
//   web/src/assets/coins/<key>.png    one coin's logo
//   web/src/assets/chains/<code>.png  one chain's logo
// A source is data, never code: only a PNG, a WebP or a JPEG is read, told by the file's own first
// bytes and not by its name, and nothing larger than 2 MB. Whatever else is in the folder stops the run.
//
// What is written:
//   web/public/coins/<key>.webp, web/public/chains/<code>.webp
// each 96 x 96 pixels: 32 px at three device pixels to the pixel. The picture is only scaled and
// centred, never recoloured or redrawn:
//   - a logo with its own round or square ground fills the picture (the page crops it to a circle);
//   - any other logo is placed whole inside the circle, on a plain ground: white, or near black
//     under a mark that is itself light, so that nothing of it is cut off and it shows on both themes.
// The colour profile is left out of the file, and a picture that would be over 12 KB without losing
// anything is written with the least loss that brings it under.
//
// Uses the Chrome already installed on this machine, for its decoders, its scaling and its encoder.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const FOLDERS = [
  { from: path.resolve("web", "src", "assets", "coins"), to: path.resolve("web", "public", "coins") },
  { from: path.resolve("web", "src", "assets", "chains"), to: path.resolve("web", "public", "chains") },
];
/** The side of every icon made, in pixels. */
export const ICON_SIDE = 96;
const MAX_SOURCE = 2 * 1024 * 1024;
const MAX_ICON = 12 * 1024;

/** What a file is, by its first bytes. Null for anything that is not one of the three kinds of picture read here. */
export function pictureType(bytes: Buffer): "image/png" | "image/webp" | "image/jpeg" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

/** A WebP without the colour profile Chrome writes into it: the pixels are already in the web's own colour space. */
function withoutProfile(webp: Buffer): Buffer {
  if (webp.toString("latin1", 0, 4) !== "RIFF" || webp.toString("latin1", 8, 12) !== "WEBP") throw new Error("make-coin-icons: not a WebP");
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

interface Made {
  /** How the logo was placed: filling the picture, or whole inside the circle on a ground. */
  placed: "fills" | "inside, on white" | "inside, on near black";
  /** The picture at each quality tried, the one that loses nothing first. */
  tries: string[];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  // The page that does the scaling can reach nothing: a picture is handed to it as bytes and it has no network.
  const context = await browser.newContext({ offline: true, javaScriptEnabled: true });
  const page = await context.newPage();
  await page.setContent("<!doctype html><title>icons</title>");

  let total = 0;
  for (const { from, to } of FOLDERS) {
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(to, { recursive: true });
    for (const file of fs.readdirSync(from).sort()) {
      if (file.startsWith(".")) continue;
      const key = file.replace(/\.[^.]+$/, "");
      if (!/^[a-z0-9]+$/.test(key)) throw new Error(`make-coin-icons: ${file}: a source is named in small letters and digits only`);
      const bytes = fs.readFileSync(path.join(from, file));
      if (bytes.length > MAX_SOURCE) throw new Error(`make-coin-icons: ${file}: larger than 2 MB`);
      const type = pictureType(bytes);
      if (type === null) throw new Error(`make-coin-icons: ${file}: not a PNG, a WebP or a JPEG`);

      const made: Made = await page.evaluate(
        async ([base64, mime, side, qualities]) => {
          const SIDE = side as number;
          const raw = Uint8Array.from(atob(base64 as string), (c) => c.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([raw], { type: mime as string }));
          const w = bitmap.width;
          const h = bitmap.height;
          const probe = new OffscreenCanvas(w, h);
          const seen = probe.getContext("2d")!;
          seen.drawImage(bitmap, 0, 0);
          const { data } = seen.getImageData(0, 0, w, h);
          // (No function is named in here: the page is handed this code as written, and knows nothing of the helpers a build adds.)

          // The box round everything that is not empty ground.
          let left = w;
          let top = h;
          let right = -1;
          let bottom = -1;
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              if (data[(y * w + x) * 4 + 3]! < 8) continue;
              if (x < left) left = x;
              if (x > right) right = x;
              if (y < top) top = y;
              if (y > bottom) bottom = y;
            }
          }
          if (right < 0) throw new Error("the picture is empty");
          const bw = right - left + 1;
          const bh = bottom - top + 1;
          const cx = left + bw / 2;
          const cy = top + bh / 2;
          const half = Math.max(bw, bh) / 2;

          // Does the logo bring its own ground? Square: its four corners are filled. Round: it is as
          // wide as it is high and the disc inside its box is filled all the way to the edge.
          const cornersFilled = [data[(top * w + left) * 4 + 3]!, data[(top * w + right) * 4 + 3]!, data[(bottom * w + left) * 4 + 3]!, data[(bottom * w + right) * 4 + 3]!].every((a) => a >= 250);
          let inDisc = 0;
          let filled = 0;
          let far = 0;
          let light = 0;
          let inked = 0;
          for (let y = top; y <= bottom; y++) {
            for (let x = left; x <= right; x++) {
              const a = data[(y * w + x) * 4 + 3]!;
              const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
              if (distance <= half * 0.97) {
                inDisc++;
                if (a >= 250) filled++;
              }
              if (a >= 8) {
                if (distance > far) far = distance;
                const i = (y * w + x) * 4;
                light += ((0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255) * (a / 255);
                inked += a / 255;
              }
            }
          }
          const round = Math.abs(bw - bh) <= Math.max(bw, bh) * 0.03 && filled / inDisc >= 0.985;
          const fills = (cornersFilled && Math.abs(bw - bh) <= Math.max(bw, bh) * 0.03) || round;
          const onDark = !fills && light / inked >= 0.8;

          const canvas = new OffscreenCanvas(SIDE, SIDE);
          const drawing = canvas.getContext("2d")!;
          drawing.imageSmoothingEnabled = true;
          drawing.imageSmoothingQuality = "high";
          // Filling: the box round the logo becomes the whole picture. Otherwise the furthest point of
          // the logo from its middle lands a little inside the circle the page crops to.
          const scale = fills ? SIDE / (2 * half) : (SIDE / 2) * 0.84 / far;
          if (!fills) {
            drawing.fillStyle = onDark ? "#111317" : "#ffffff";
            drawing.fillRect(0, 0, SIDE, SIDE);
          }
          // Scaled down in halves first, so that a large source keeps its fine lines.
          let source: ImageBitmap | OffscreenCanvas = bitmap;
          let shrunk = 1;
          while (scale * shrunk < 0.5) {
            const next: OffscreenCanvas = new OffscreenCanvas(Math.ceil(source.width / 2), Math.ceil(source.height / 2));
            const step = next.getContext("2d")!;
            step.imageSmoothingQuality = "high";
            step.drawImage(source, 0, 0, next.width, next.height);
            shrunk *= source.width / next.width;
            source = next;
          }
          const by = scale * shrunk;
          drawing.drawImage(source, SIDE / 2 - (cx / shrunk) * by, SIDE / 2 - (cy / shrunk) * by, source.width * by, source.height * by);

          const tries: string[] = [];
          for (const quality of qualities as readonly number[]) {
            // Quality 1 makes Chrome write a WebP that loses nothing.
            const out = new Uint8Array(await (await canvas.convertToBlob({ type: "image/webp", quality })).arrayBuffer());
            let text = "";
            for (let i = 0; i < out.length; i += 0x8000) text += String.fromCharCode(...out.subarray(i, i + 0x8000));
            tries.push(btoa(text));
          }
          return { placed: fills ? "fills" : onDark ? "inside, on near black" : "inside, on white", tries } as const;
        },
        [bytes.toString("base64"), type, ICON_SIDE, [1, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6]] as const,
      );

      const candidates = made.tries.map((base64) => withoutProfile(Buffer.from(base64, "base64")));
      const chosen = candidates.find((webp) => webp.length <= MAX_ICON);
      if (chosen === undefined) throw new Error(`make-coin-icons: ${file}: cannot be written under 12 KB`);
      const out = path.join(to, `${key}.webp`);
      fs.writeFileSync(out, chosen);
      total += chosen.length;
      console.log(`  ${path.relative(path.resolve("web", "public"), out)}  ${made.placed}  ${(chosen.length / 1024).toFixed(1)} KB${chosen === candidates[0] ? "" : " (with a little loss)"}`);
    }
  }
  await browser.close();
  console.log(`make-coin-icons: ${(total / 1024).toFixed(1)} KB written in all`);
}
