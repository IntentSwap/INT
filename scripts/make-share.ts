// Draws the image a link to the site shows when it is shared: 1200 by 630, the wordmark, one
// line of words and the swap card as it really looks. Run it again when the card changes.
//
//   npx tsx scripts/make-share.ts <address of the running site> [--private]
//
// With --private it draws the image for a site that routes swaps privately (give it the address of
// a site that is running that way): the words are the private ones and it goes to share-private.png.
//
// The card is photographed from the running site in its resting state, before any amount is
// typed, so the image holds no rate and no number that could go stale. It is taller than the
// image, so it runs off the bottom edge. Uses the Chrome already installed on this machine.
// Output goes to web/public/share.png.

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const site = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
/** Which image: the one for a site that routes privately, or the usual one. */
const privately = process.argv.includes("--private");
if (site === undefined) {
  console.error("make-share: give the address of the running site, for example http://127.0.0.1:8799");
  process.exit(1);
}

const WIDTH = 1200;
const HEIGHT = 630;
const BACKGROUND = "#0a0b0d";
const INK = "#f2f3f5";
const MUTED = "#9ba1ab";
const PAD = 64;
/** The card's width in the image. Its height follows; what does not fit runs off the bottom. */
const CARD_WIDTH = 440;

const browser = await chromium.launch({ channel: "chrome", headless: true });

// 1. The card, from the site itself, in the dark theme.
const shop = await browser.newContext({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2, colorScheme: "dark" });
const live = await shop.newPage();
await live.goto(site, { waitUntil: "networkidle" });
const card = live.locator(".card");
await card.waitFor();
await live.locator(".coin-button").first().waitFor();
// Icons are images of their own: wait until every one in the card has been drawn.
await live.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".card img")].every((img) => img.complete && img.naturalWidth > 0));
await live.evaluate(() => document.fonts.ready);
// The card as it rests, not as it looks with the keyboard in its first field.
await live.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const box = await card.boundingBox();
if (box === null) throw new Error("the card is not on the page");
const photo = await card.screenshot({ type: "png" });
await shop.close();

// 2. The image: the logo and the name top-left, the line of words, the card on the right. The logo
// is the site's own copy of the owner's artwork, at the size it is drawn here (scripts/make-brand.ts).
const logo = fs.readFileSync(path.resolve("web", "public", "brand", "logo-32.webp")).toString("base64");
const font = fs.readFileSync(path.resolve("web", "src", "assets", "fonts", "geist-latin.woff2")).toString("base64");
const scale = CARD_WIDTH / box.width;
const cardWidth = CARD_WIDTH;
const cardHeight = Math.round(box.height * scale);
const html = `<!doctype html><html><head><style>
@font-face { font-family: "Geist"; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 100 900; }
* { margin: 0; box-sizing: border-box; }
body { position: relative; overflow: hidden; width: ${WIDTH}px; height: ${HEIGHT}px; background: ${BACKGROUND}; color: ${INK}; font-family: "Geist", sans-serif; display: grid; grid-template-columns: minmax(0, 1fr) ${cardWidth}px; gap: ${PAD}px; padding: ${PAD}px ${PAD}px 0; }
.words { display: grid; grid-template-rows: auto 1fr; min-width: 0; padding-bottom: ${PAD}px; }
.wordmark { display: flex; align-items: center; gap: 12px; font-size: 28px; line-height: 34px; font-weight: 600; letter-spacing: -0.02em; }
.line { align-self: center; font-size: 64px; line-height: 68px; font-weight: 600; letter-spacing: -0.02em; padding-bottom: 34px; }
.line span { color: ${MUTED}; }
img { width: ${cardWidth}px; height: ${cardHeight}px; display: block; }
.wordmark img { width: 32px; height: 32px; }
/* The card leaves by the bottom edge: it fades into the background there, so the cut reads as meant. */
.fade { position: absolute; left: 0; right: 0; bottom: 0; height: 120px; background: linear-gradient(to bottom, transparent, ${BACKGROUND}); }
</style></head><body>
<div class="words">
<div class="wordmark"><img alt="" width="32" height="32" src="data:image/webp;base64,${logo}">IntentSwap</div>
<p class="line">${privately ? "Private swaps,<br>across chains.<br><span>Built on NEAR Intents.</span>" : "Swap any coin<br>to any coin,<br><span>across chains.</span>"}</p>
</div>
<img alt="" src="data:image/png;base64,${photo.toString("base64")}">
<div class="fade"></div>
</body></html>`;

const frame = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
const sheet = await frame.newPage();
await sheet.setContent(html, { waitUntil: "load" });
await sheet.evaluate(() => document.fonts.ready);
const out = path.resolve("web", "public", privately ? "share-private.png" : "share.png");
await sheet.screenshot({ path: out, type: "png", clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
await browser.close();
console.log(`make-share: wrote ${path.basename(out)} (${WIDTH} x ${HEIGHT}, ${(fs.statSync(out).size / 1024).toFixed(0)} KB), card ${cardWidth} x ${cardHeight}`);
