// The two coin selectors on the swap card, measured in a real browser. Used by scripts/review-shots.ts
// (walk name: chips).
//
// What the walk proves, at 360, 768 and 1280 px and in both themes:
//   - the two selectors are the same width and height, and their icons, their text and their chevrons
//     start at the same place across the page; each icon stands in line with the field's label above it;
//   - a selector has no border and no fill of its own, and a hairline stands between it and the amount;
//   - a long symbol is cut short with an ellipsis and the selector does not grow;
//   - every coin's chain badge is the same size and sits at the same place on its icon (measured on
//     the two selectors, and on every coin on the page of states), and the ring round it is the colour
//     of what it sits on (the field's tint over the card's, on the plain page), also when the selector
//     is pressed or pointed at;
//   - a coin with no artwork shows two letters at both sizes.
// It also saves the two selectors at four times their size, for looking at.

import path from "node:path";
import type { Browser, Page } from "playwright-core";

export interface WalkResult {
  complaints: string[];
  shots: number;
}

interface Measured {
  chip: { x: number; y: number; width: number; height: number; bottom: number };
  icon: { x: number; y: number; width: number; height: number };
  text: { x: number };
  chevron: { right: number };
  badge: { width: number; height: number; right: number; bottom: number; radius: string; ring: string; spread: string };
  background: string;
  border: string;
  /** What the selector sits on, as one colour: the page, the card's tint over it, the field's tint over that, and the selector's own over that. */
  under: string;
  label: { x: number };
  divider: { width: string; x: number };
  symbol: { size: string; weight: string };
  cut: boolean;
}

/** Runs in the page: measures every coin chip on the card. */
const MEASURE = `(() => [...document.querySelectorAll("button.coin-button")].map((chip) => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
  const icon = chip.querySelector(".coin-icon");
  const badge = chip.querySelector(".coin-icon-badge");
  const symbol = chip.querySelector(".coin-button-symbol");
  const chevron = chip.querySelector(":scope > svg");
  const badgeStyle = getComputedStyle(badge);
  const ring = /rgba?\\([^)]+\\)/.exec(badgeStyle.boxShadow);
  // One colour drawn over another: "rgba(r, g, b, a)" over "rgb(r, g, b)".
  const parse = (text) => { const m = /rgba?\\(([^)]+)\\)/.exec(text); const p = m ? m[1].split(",").map(Number) : [0, 0, 0, 0]; return { rgb: p.slice(0, 3), alpha: p.length > 3 ? p[3] : 1 }; };
  const over = (top, under) => { const t = parse(top); const u = parse(under).rgb; return "rgb(" + t.rgb.map((c, i) => Math.round(t.alpha * c + (1 - t.alpha) * u[i])).join(", ") + ")"; };
  const field = chip.closest(".field");
  const card = chip.closest(".card");
  const value = field.querySelector(".field-value");
  const layers = [getComputedStyle(card).backgroundColor, getComputedStyle(field).backgroundColor, getComputedStyle(chip).backgroundColor];
  const under = layers.reduce((below, layer) => over(layer, below), getComputedStyle(document.body).backgroundColor);
  return {
    chip: box(chip),
    icon: box(icon),
    text: { x: box(symbol).x },
    chevron: { right: box(chevron).right },
    badge: { width: box(badge).width, height: box(badge).height, right: box(badge).right - box(icon).right, bottom: box(badge).bottom - box(icon).bottom, radius: badgeStyle.borderRadius, ring: ring ? ring[0] : badgeStyle.boxShadow, spread: badgeStyle.boxShadow.replace(/rgba?\\([^)]+\\)/, "").trim() },
    background: getComputedStyle(chip).backgroundColor,
    border: getComputedStyle(chip).borderTopWidth,
    under,
    label: { x: box(field.querySelector(".field-label")).x },
    divider: { width: getComputedStyle(value).borderLeftWidth, x: box(value).x },
    symbol: { size: getComputedStyle(symbol).fontSize, weight: getComputedStyle(symbol).fontWeight },
    cut: symbol.scrollWidth > symbol.clientWidth,
  };
}))()`;

export async function chipsWalk(browser: Browser, options: { baseUrl: string; out: string; visit(page: Page, url: string): Promise<void> }): Promise<WalkResult> {
  const complaints: string[] = [];
  let shots = 0;
  const { baseUrl, out, visit } = options;
  const same = (a: number, b: number) => Math.abs(a - b) < 0.01;
  /** Two colours are the same to the eye: no channel differs by more than one step in 255 (the layers are rounded as they are added up). */
  const sameColour = (a: string, b: string) => {
    const parts = (text: string) => (/rgba?\(([^)]+)\)/.exec(text)?.[1] ?? "").split(",").slice(0, 3).map(Number);
    const [x, y] = [parts(a), parts(b)];
    return x.length === 3 && y.length === 3 && x.every((channel, index) => Math.abs(channel - (y[index] ?? -9)) <= 1);
  };

  for (const theme of ["dark", "light"] as const) {
    for (const width of [360, 768, 1280] as const) {
      const label = `chips ${width} ${theme}`;
      const expectThat = (ok: boolean, what: string) => {
        if (!ok) complaints.push(`${label}: ${what}`);
      };
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 4, colorScheme: theme });
      await context.addInitScript(`try { localStorage.setItem("theme", "${theme}"); } catch {}`);
      const page = await context.newPage();
      page.on("pageerror", (error) => complaints.push(`${label}: page error: ${error.message}`));
      try {
        // A pair with a short symbol and a long one: the chips must still be one size.
        for (const query of ["/", "/?from=base:ETH&to=near:BLACKDRAGON", "/?from=bsc:BNB&to=arb:USDT0"]) {
          await visit(page, new URL(query, baseUrl).toString());
          await page.locator("button.coin-button").nth(1).waitFor({ timeout: 20_000 });
          await page.waitForTimeout(300);
          const chips = (await page.evaluate(MEASURE)) as Measured[];
          expectThat(chips.length === 2, `${query}: there are ${chips.length} coin chips on the card`);
          const [pay, receive] = chips as [Measured, Measured];
          expectThat(same(pay.chip.width, receive.chip.width) && same(pay.chip.height, receive.chip.height), `${query}: the chips are ${pay.chip.width}×${pay.chip.height} and ${receive.chip.width}×${receive.chip.height}`);
          // 132 px wide on a narrow screen, 148 px from 480 px up; as tall as the field's row.
          const wide = width >= 480 ? 148 : 132;
          expectThat(same(pay.chip.width, wide) && same(pay.chip.height, 52), `${query}: a selector is ${pay.chip.width}×${pay.chip.height}, not ${wide}×52`);
          expectThat(same(pay.chip.x, receive.chip.x), `${query}: the chips start at ${pay.chip.x} and ${receive.chip.x}`);
          expectThat(same(pay.icon.x, receive.icon.x), `${query}: the icons start at ${pay.icon.x} and ${receive.icon.x}`);
          expectThat(same(pay.text.x, receive.text.x), `${query}: the text starts at ${pay.text.x} and ${receive.text.x}`);
          expectThat(same(pay.chevron.right, receive.chevron.right), `${query}: the chevrons end at ${pay.chevron.right} and ${receive.chevron.right}`);
          for (const [side, chip] of [["pay", pay], ["receive", receive]] as const) {
            expectThat(same(chip.icon.width, 24) && same(chip.icon.height, 24), `${query}: the ${side} icon is ${chip.icon.width}×${chip.icon.height}`);
            expectThat(same(chip.icon.x - chip.chip.x, 8) && same(chip.text.x - chip.chip.x, 40), `${query}: in the ${side} selector the icon is ${chip.icon.x - chip.chip.x} in and the text ${chip.text.x - chip.chip.x} in`);
            // The icon stands under the field's label, on one line with it.
            expectThat(same(chip.icon.x, chip.label.x), `${query}: the ${side} icon starts at ${chip.icon.x}, the label above it at ${chip.label.x}`);
            expectThat(chip.symbol.size === "16px" && chip.symbol.weight === "500", `${query}: the ${side} symbol is set at ${chip.symbol.size}, weight ${chip.symbol.weight}`);
            // No border, and no fill until it is pointed at; a one-pixel hairline between it and the amount.
            expectThat(chip.border === "0px" && chip.background === "rgba(0, 0, 0, 0)", `${query}: the ${side} selector has a border of ${chip.border} and a fill of ${chip.background}`);
            expectThat(chip.divider.width === "1px" && chip.divider.x > chip.chip.x + chip.chip.width, `${query}: the hairline beside the ${side} selector is ${chip.divider.width} wide at ${chip.divider.x}`);
            expectThat(same(chip.badge.width, 10) && same(chip.badge.height, 10) && chip.badge.radius === "3px", `${query}: the ${side} badge is ${chip.badge.width}×${chip.badge.height}, radius ${chip.badge.radius}`);
            expectThat(same(chip.badge.right, 3) && same(chip.badge.bottom, 3), `${query}: the ${side} badge reaches ${chip.badge.right} right and ${chip.badge.bottom} down of its icon`);
            expectThat(sameColour(chip.badge.ring, chip.under), `${query}: the ${side} badge's ring is ${chip.badge.ring} on a field that comes to ${chip.under}`);
            // A ring, not a shadow: no offset, no blur, a pixel and a half wide.
            expectThat(chip.badge.spread === "0px 0px 0px 1.5px", `${query}: the ${side} badge's ring is drawn as "${chip.badge.spread}"`);
          }
          if (query.includes("BLACKDRAGON")) expectThat(receive.cut, "a long symbol is not cut short");
          if (query === "/") {
            // Four times life size, both chips, each with a little of what is around it.
            for (const [side, index] of [["pay", 0], ["receive", 1]] as const) {
              const box = await page.locator("button.coin-button").nth(index).boundingBox();
              if (box === null) continue;
              await page.screenshot({ path: path.join(out, `chip-4x-${side}-${width}-${theme}.png`), clip: { x: box.x - 12, y: box.y - 8, width: box.width + 24, height: box.height + 16 } });
              shots += 1;
            }
            // Pointed at: the chip changes tone, and the ring with it.
            if (width >= 768) {
              await page.locator("button.coin-button").first().hover();
              await page.waitForTimeout(250);
              const hovered = ((await page.evaluate(MEASURE)) as Measured[])[0];
              expectThat(hovered !== undefined && sameColour(hovered.badge.ring, hovered.under) && hovered.background !== pay.background, `pointed at, the badge's ring is ${hovered?.badge.ring} on a selector that comes to ${hovered?.under}`);
              // Pressed: the same.
              const at = await page.locator("button.coin-button").first().boundingBox();
              if (at !== null) {
                await page.mouse.move(at.x + at.width - 20, at.y + at.height / 2);
                await page.mouse.down();
                await page.waitForTimeout(250);
                const pressed = ((await page.evaluate(MEASURE)) as Measured[])[0];
                expectThat(pressed !== undefined && sameColour(pressed.badge.ring, pressed.under), `pressed, the badge's ring is ${pressed?.badge.ring} on a selector that comes to ${pressed?.under}`);
                // Let go away from the chip, so that nothing opens.
                await page.mouse.move(0, 0);
                await page.mouse.up();
              }
              await page.mouse.move(0, 0);
            }
          }
        }
        // Every coin shown on the page of states: one badge, the same size and in the same place on every
        // icon of a size, artwork or none; and a coin with no artwork shows two letters at both sizes.
        if (width === 1280) {
          await visit(page, new URL("/states", baseUrl).toString());
          await page.locator(".states-icons .coin-icon").first().waitFor({ timeout: 20_000 });
          // The page fetches an icon only as it nears the screen. For this check every one is asked for now.
          await page.evaluate(`Promise.all([...document.querySelectorAll(".states-icons img")].map((img) => { img.loading = "eager"; return img.decode().catch(() => undefined); }))`);
          const icons = (await page.evaluate(`(() => [...document.querySelectorAll(".states-icons .coin-icon")].map((icon) => {
            const badge = icon.querySelector(".coin-icon-badge");
            const a = icon.getBoundingClientRect();
            const b = badge.getBoundingClientRect();
            const fallback = icon.querySelector(".coin-icon-fallback");
            const image = icon.querySelector("img.coin-icon-image");
            return { size: icon.dataset.size, w: a.width, h: a.height, bw: b.width, bh: b.height, right: b.right - a.right, bottom: b.bottom - a.bottom, radius: getComputedStyle(badge).borderRadius, letters: fallback ? fallback.textContent : null, weight: fallback ? getComputedStyle(fallback).fontWeight : null, loaded: image ? image.complete && image.naturalWidth > 0 : null };
          }))()`)) as { size: string; w: number; h: number; bw: number; bh: number; right: number; bottom: number; radius: string; letters: string | null; weight: string | null; loaded: boolean | null }[];
          expectThat(icons.length >= 60, `the page of states shows ${icons.length} coin icons`);
          const want = { "32": { size: 32, badge: 14, out: 4, radius: "4px" }, "24": { size: 24, badge: 10, out: 3, radius: "3px" } } as const;
          for (const [index, icon] of icons.entries()) {
            const rule = want[icon.size as "32" | "24"];
            expectThat(rule !== undefined && same(icon.w, rule.size) && same(icon.h, rule.size) && same(icon.bw, rule.badge) && same(icon.bh, rule.badge) && same(icon.right, rule.out) && same(icon.bottom, rule.out) && icon.radius === rule.radius, `coin icon ${index} on the page of states is ${JSON.stringify(icon)}`);
            if (icon.loaded !== null) expectThat(icon.loaded, `coin icon ${index} on the page of states did not load its artwork`);
          }
          const fallbacks = icons.filter((icon) => icon.letters !== null);
          expectThat(fallbacks.length >= 2 && fallbacks.every((icon) => (icon.letters ?? "").length === 2 && icon.weight === "600"), `coins with no artwork show ${JSON.stringify(fallbacks.map((icon) => [icon.size, icon.letters, icon.weight]))}`);
        }
      } catch (error) {
        complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
      }
      await context.close();
    }
  }
  return { complaints, shots };
}
