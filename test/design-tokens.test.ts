import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHAINS } from "../shared/chains.ts";
import { CHAIN_COLOURS, chainColour } from "../web/src/lib/icons.ts";

const stylesDir = path.resolve("web", "src");
const tokensCss = fs.readFileSync(path.join(stylesDir, "styles", "tokens.css"), "utf8");
const pickerCss = fs.readFileSync(path.join(stylesDir, "styles", "picker.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

type Rgb = [number, number, number];
interface Colour {
  rgb: Rgb;
  alpha: number;
}

function parseColour(value: string): Colour {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const h = hex[1]!;
    return { rgb: [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)], alpha: 1 };
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value.trim());
  if (rgba) return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  throw new Error(`not a colour: ${value}`);
}

/** Reads one theme's variables out of the token file. */
function theme(selector: string): Record<string, string> {
  const start = tokensCss.indexOf(selector);
  if (start === -1) throw new Error(`no block for ${selector}`);
  const block = tokensCss.slice(tokensCss.indexOf("{", start) + 1, tokensCss.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[match[1]!] = match[2]!.trim();
  return out;
}

const linear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const over = (top: Colour, under: Rgb): Rgb => top.rgb.map((c, i) => top.alpha * c + (1 - top.alpha) * under[i]!) as Rgb;

/** WCAG contrast ratio of a (possibly see-through) colour drawn on a solid background. */
function contrast(foreground: string, background: string): number {
  const bg = parseColour(background).rgb;
  const a = luminance(over(parseColour(foreground), bg));
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const THEMES = { dark: theme(':root[data-theme="dark"]'), light: theme(':root[data-theme="light"]') };
const BACKGROUNDS = ["--bg", "--surface", "--raised"] as const;
const TEXT = ["--text", "--text-muted", "--text-faint", "--accent", "--warning", "--danger"] as const;

describe("contrast, computed from the token file", () => {
  for (const [name, vars] of Object.entries(THEMES)) {
    describe(`${name} theme`, () => {
      it.each(TEXT.flatMap((token) => BACKGROUNDS.map((background) => [token, background] as const)))("%s on %s is at least 4.5:1", (token, background) => {
        expect(contrast(vars[token]!, vars[background]!)).toBeGreaterThanOrEqual(4.5);
      });

      it.each(BACKGROUNDS)("the control outline on %s is at least 3:1", (background) => {
        expect(contrast(vars["--border-control"]!, vars[background]!)).toBeGreaterThanOrEqual(3);
      });

      it.each(BACKGROUNDS)("the keyboard's mark on %s is at least 3:1", (background) => {
        expect(contrast(vars["--focus-ring"]!, vars[background]!)).toBeGreaterThanOrEqual(3);
      });

      it("the keyboard's mark is a neutral tone of about 45 per cent, never the accent", () => {
        const ring = parseColour(vars["--focus-ring"]!);
        expect(new Set(ring.rgb).size).toBe(1);
        expect(ring.alpha).toBeGreaterThanOrEqual(0.4);
        expect(ring.alpha).toBeLessThanOrEqual(0.5);
        expect(vars["--focus-ring"]).not.toBe(vars["--accent"]);
      });

      it("a primary button that cannot act still has a readable label: its reason is the label", () => {
        // The quiet fill is see-through, so it is measured as drawn on the card and on the page.
        for (const background of ["--surface", "--bg"] as const) {
          const [r, g, b] = over(parseColour(vars["--fill-blocked"]!), parseColour(vars[background]!).rgb).map(Math.round);
          expect(contrast(vars["--text-muted"]!, `rgb(${r}, ${g}, ${b})`)).toBeGreaterThanOrEqual(4.5);
        }
      });

      it("the primary button's label is readable on its fill, and the fill stands out from every background", () => {
        expect(contrast(vars["--bg"]!, vars["--text"]!)).toBeGreaterThanOrEqual(4.5);
        for (const background of BACKGROUNDS) expect(contrast(vars["--text"]!, vars[background]!)).toBeGreaterThanOrEqual(3);
      });
    });
  }

  // The swap card is see-through, so what its text is read
  // against is not one colour: it is the card's tint over whatever of the page lies behind it. The
  // two ends of that are measured: the plain page, and the page at the brightest point of the light
  // behind the hero. (The grid's lines are a pixel wide and are blurred away behind the card.)
  describe.each(Object.entries(THEMES))("the see-through swap card, %s theme", (_name, vars) => {
    const solid = (colour: Rgb) => `rgb(${colour.map(Math.round).join(", ")})`;
    const page = parseColour(vars["--bg"]!).rgb;
    const lit = over(parseColour(vars["--glow"]!), page);
    const layers = (behind: Rgb, ...tints: string[]) => tints.reduce((under, tint) => over(parseColour(vars[tint]!), under), behind);

    it("is a tint of 55 to 70 per cent", () => {
      const alpha = parseColour(vars["--card-tint"]!).alpha;
      expect(alpha).toBeGreaterThanOrEqual(0.55);
      expect(alpha).toBeLessThanOrEqual(0.7);
    });

    it.each(TEXT.flatMap((token) => [[token, "the card", ["--card-tint"]] as const, [token, "a field", ["--card-tint", "--field-tint"]] as const]))("%s on %s is at least 4.5:1, on the plain page and over the light", (token, _where, tints) => {
      for (const behind of [page, lit]) expect(contrast(vars[token]!, solid(layers(behind, ...tints)))).toBeGreaterThanOrEqual(4.5);
    });

    // What is drawn on the tint that comes up under the pointer: a coin's symbol and its chain, the tools' icons, the quote's rate.
    it.each(["--text", "--text-muted"] as const)("%s on a field under the pointer is at least 4.5:1, on the plain page and over the light", (token) => {
      for (const behind of [page, lit]) expect(contrast(vars[token]!, solid(layers(behind, "--card-tint", "--field-tint", "--hover-tint")))).toBeGreaterThanOrEqual(4.5);
    });

    // The coin picker's list: a coin's name, its symbol and its shortened contract, on the card itself and on the row under the pointer or the arrow keys.
    it.each(["--text", "--text-muted"] as const)("%s on a row of the coin picker is at least 4.5:1, at rest and highlighted, on the plain page and over the light", (token) => {
      for (const behind of [page, lit]) for (const tints of [["--card-tint"], ["--card-tint", "--hover-tint"]]) expect(contrast(vars[token]!, solid(layers(behind, ...tints)))).toBeGreaterThanOrEqual(4.5);
    });

    it("nothing on a row of the coin picker is in the faintest text colour, which a highlighted row would leave too quiet to read", () => {
      // (The reason, measured: in the dark theme it falls under 4.5:1 on the highlighted row over the light.)
      const rows = [...pickerCss.matchAll(/(?<=^|[{}])\s*([^{}@]+?)\s*\{([^{}]*)\}/g)].filter((match) => /\.picker-(row|pick|link|heading)/.test(match[1]!));
      expect(rows.length).toBeGreaterThan(8);
      for (const match of rows) expect(match[2], match[1]!.trim()).not.toMatch(/var\(--text-faint\)/);
    });

    // A chain's tile is washed with the chain's own colour: 8 per cent at rest, 14 under the pointer, 22 when chosen
    // (picker.css). Its name is read against that wash over the card, whichever of the chain colours it is.
    it("a chain's name is at least 4.5:1 on its tile, for every chain's colour and every strength of the wash", () => {
      const washes = [...pickerCss.matchAll(/color-mix\(in srgb, var\(--chain-colour\) (\d+)%, transparent\)/g)].map((match) => Number(match[1]) / 100);
      expect(washes.sort()).toEqual([0.08, 0.14, 0.22]);
      for (const colour of new Set(Object.values(CHAIN_COLOURS))) {
        for (const wash of washes) {
          for (const behind of [page, lit]) {
            const tile = over({ rgb: parseColour(colour).rgb, alpha: wash }, layers(behind, "--card-tint"));
            expect(contrast(vars["--text"]!, solid(tile)), `${colour} at ${wash}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    });

    it("the small labels are readable on their own tints", () => {
      // The quote's line, which they sit on, keeps the field's tint under the pointer: a test below holds it to that.
      for (const behind of [page, lit]) {
        const field = layers(behind, "--card-tint", "--field-tint");
        expect(contrast(vars["--accent"]!, solid(over(parseColour(vars["--tint-accent"]!), field)))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(vars["--warning"]!, solid(over(parseColour(vars["--tint-warning"]!), field)))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(vars["--text-muted"]!, solid(over(parseColour(vars["--tint-neutral"]!), field)))).toBeGreaterThanOrEqual(4.5);
      }
    });

    it("the keyboard's mark stands out from the card and its fields", () => {
      for (const behind of [page, lit]) for (const tints of [["--card-tint"], ["--card-tint", "--field-tint"]]) expect(contrast(vars["--focus-ring"]!, solid(layers(behind, ...tints)))).toBeGreaterThanOrEqual(3);
    });

    it("the solid colours are what the layers come to on the plain page", () => {
      const hex = (colour: Rgb) => `#${colour.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
      expect(vars["--card-solid"]).toBe(hex(layers(page, "--card-tint")));
      // A coin in the picker's list sits on the card itself, and under the pointer on the card's tint with the pointer's over it.
      expect(vars["--card-solid-hover"]).toBe(hex(layers(page, "--card-tint", "--hover-tint")));
      expect(vars["--field-solid"]).toBe(hex(layers(page, "--card-tint", "--field-tint")));
      expect(vars["--field-solid-hover"]).toBe(hex(layers(page, "--card-tint", "--field-tint", "--hover-tint")));
    });
  });

  it("defines the same colour tokens in both themes", () => {
    expect(Object.keys(THEMES.dark).sort()).toEqual(Object.keys(THEMES.light).sort());
  });

  it("uses the set palette, with a control outline strong enough to be seen", () => {
    expect(THEMES.dark).toMatchObject({ "--bg": "#0a0b0d", "--surface": "#111317", "--raised": "#181b20", "--text": "#f2f3f5", "--text-muted": "#9ba1ab", "--text-faint": "#7f8794", "--accent": "#00ec97", "--warning": "#f5b544", "--danger": "#f2555a" });
    expect(THEMES.light).toMatchObject({ "--bg": "#f7f7f5", "--surface": "#ffffff", "--raised": "#f1f1ee", "--text": "#111317", "--text-muted": "#5b616b", "--text-faint": "#5f656f", "--accent": "#006e46", "--warning": "#8a5a00", "--danger": "#c4262e" });
    // A dark control outline of 0.32 would measure 2.81:1 on the page background, under the 3:1 rule. It is 0.34.
    expect(contrast("rgba(255, 255, 255, 0.32)", THEMES.dark["--bg"]!)).toBeLessThan(3);
    expect(THEMES.dark["--border-control"]).toBe("rgba(255, 255, 255, 0.34)");
    expect(THEMES.light["--border-control"]).toBe("rgba(0, 0, 0, 0.45)");
  });
});

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(full);
    return entry.name.endsWith(".css") ? [full] : [];
  });
}

describe("every pressable or typable control can be told from what is around it", () => {
  // Away from the swap card, a control has an outline of at least 3:1 (the token is checked above;
  // this checks that the controls use it). The swap card has one-pixel hairlines at low contrast
  // and nothing heavier: there a control is told by its own fill
  // and its words, and by a focus ring of at least 3:1 (checked above, on the see-through card).
  const css = cssFiles(stylesDir).map((file) => fs.readFileSync(file, "utf8")).join("\n");
  /** Every rule block for a selector, joined (a selector may share one block and have another of its own). */
  const rule = (selector: string): string => {
    const blocks: string[] = [];
    for (let start = css.indexOf(`\n${selector} {`); start !== -1; start = css.indexOf(`\n${selector} {`, start + 1)) blocks.push(css.slice(start, css.indexOf("}", start)));
    if (blocks.length === 0) throw new Error(`no rule for ${selector}`);
    return blocks.join("\n");
  };
  it.each([".button-secondary", ".button-chip"])("%s", (selector) => {
    expect(rule(selector)).toMatch(/border: var\(--border-width\) solid var\(--border-control\);/);
  });

  describe("on the swap card", () => {
    const card = fs.readFileSync(path.join(stylesDir, "styles", "card.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

    it.each([".card", ".tool", ".field", ".flip", ".address-input", ".quote-summary"])("%s has a one-pixel hairline", (selector) => {
      expect(rule(selector)).toMatch(/border: var\(--border-width\) solid var\(--border\);/);
    });

    it("no edge is heavier than a hairline, and none is the light grey of a control's outline", () => {
      expect(card).not.toContain("--border-control");
      for (const match of card.matchAll(/border(?:-(?:top|right|bottom|left))?(?:-width)?:\s*([^;]+);/g)) expect(match[1]!.startsWith("var(--border-width)") || match[1] === "0", match[0]).toBe(true);
    });

    it("the coin selector has no border and no fill of its own", () => {
      expect(rule(".coin-button")).not.toMatch(/\bborder:|\bbackground:/);
    });

    it.each([".field", ".address-input", ".quote-summary"])("%s is set apart by its own tint", (selector) => {
      expect(rule(selector)).toMatch(/background: var\(--field-tint\);/);
    });

    it("the quote's line keeps its tint under the pointer", () => {
      expect(card).not.toMatch(/quote-summary:(?:hover|active)[^{]*\{[^}]*background/);
    });

    it("is see-through, with the page blurred behind it", () => {
      expect(rule(".card")).toMatch(/background: var\(--card-tint\);/);
      expect(rule(".card")).toMatch(/backdrop-filter: blur\(var\(--blur-card\)\);/);
    });

    it("draws no ring of its own for focus: a field being typed in brings its hairline up, and that is all", () => {
      expect(card).not.toMatch(/box-shadow:[^;]*var\(--accent\)/);
      expect(rule(".address-input:focus")).toMatch(/border-color: var\(--border-strong\);/);
      // The amount's quiet line is round its field, and only while the keyboard is moving about.
      expect(card).not.toMatch(/(?<!\[data-keys\] )\.field:has\(\.amount-input:focus-visible\)/);
    });
  });
});

describe("where the focus is, is shown quietly and only to the keyboard", () => {
  const sheets = cssFiles(stylesDir).map((file) => [path.relative(stylesDir, file), fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")] as const);
  /** Every rule of a stylesheet: its selector and what it declares (rules inside an @media or @supports block included). */
  const rules = (css: string) => [...css.matchAll(/(?<=^|[{}])\s*([^{}@]+?)\s*\{([^{}]*)\}/g)].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));

  it("no outline anywhere is in the accent colour, and nothing that has the focus is given an accent border, ring or glow", () => {
    const found: string[] = [];
    for (const [name, css] of sheets) {
      for (const { selector, body } of rules(css)) {
        if (/outline(-color)?:[^;]*var\(--accent\)/.test(body)) found.push(`${name}: ${selector} has an accent outline`);
        if (/:focus|\[data-keys\]|\[data-active\]/.test(selector) && /(?:border(?:-[a-z]+)?|box-shadow|background|outline)(?:-color)?:[^;]*var\(--accent\)/.test(body)) found.push(`${name}: ${selector} turns accent with the focus`);
      }
    }
    expect(found).toEqual([]);
  });

  it("with the keyboard not in use, focus draws nothing; with it in use, one quiet line: 1 px, neutral, 2 px off", () => {
    const base = sheets.find(([name]) => name.endsWith("base.css"))![1];
    expect(base).toMatch(/\n:focus-visible \{\s*outline: none;\s*\}/);
    expect(base).toMatch(/:root\[data-keys\] :focus-visible \{\s*outline: var\(--border-width\) solid var\(--focus-ring\);\s*outline-offset: var\(--focus-offset\);\s*\}/);
    expect(tokensCss).toMatch(/--focus-offset: 2px;/);
    expect(tokensCss).toMatch(/--border-width: 1px;/);
  });

  it("the quiet line is never drawn by a rule that does not wait for the keyboard", () => {
    const found: string[] = [];
    for (const [name, css] of sheets) for (const { selector, body } of rules(css)) if (/var\(--focus-ring\)/.test(body) && !selector.split(",").every((part) => part.includes(":root[data-keys]"))) found.push(`${name}: ${selector}`);
    expect(found).toEqual([]);
  });

  it("a text field shows it is being typed in by its hairline alone", () => {
    for (const selector of [".address-input:focus", ".slippage-input:focus", ".picker-search:focus-within"]) {
      const all = sheets.flatMap(([, css]) => rules(css)).filter((item) => item.selector.split(",").map((part) => part.trim()).includes(selector));
      expect(all.length, selector).toBeGreaterThan(0);
      for (const item of all) expect(item.body.replace(/\s+/g, " ").trim(), selector).toBe("border-color: var(--border-strong);");
    }
  });

  it("the coin picker's highlighted row is a soft tint and never a border", () => {
    const row = sheets.flatMap(([, css]) => rules(css)).filter((item) => item.selector.includes(".picker-row[data-active]"));
    expect(row.length).toBeGreaterThan(0);
    for (const item of row) {
      // The picker is part of the see-through card: the tint is the card's own, the one that comes up under the pointer.
      expect(item.body).toMatch(/background: var\(--hover-tint\);/);
      expect(item.body).not.toMatch(/outline|border|box-shadow/);
    }
  });

  it("the chain that is chosen in the coin picker is told by its own colour: a brighter edge and a stronger wash, never the accent and never a ring", () => {
    const all = sheets.flatMap(([, css]) => rules(css));
    const chosen = all.filter((item) => item.selector.split(",").some((part) => part.includes(".chain-tile") && part.includes('[aria-selected="true"]') && !part.includes(":not(")));
    expect(chosen).toHaveLength(1);
    expect(chosen[0]!.body).toMatch(/border-color: color-mix\(in srgb, var\(--chain-colour\) \d+%, var\(--text-muted\)\);/);
    expect(chosen[0]!.body).toMatch(/background: color-mix\(in srgb, var\(--chain-colour\) 22%, transparent\);/);
    // Nothing about a chain's tile, in any state, is in the accent colour or is drawn as a ring or a heavier edge.
    for (const item of all.filter((rule) => rule.selector.includes(".chain-tile"))) {
      expect(item.body, item.selector).not.toMatch(/var\(--accent\)|box-shadow|(?<![\w-])border-width\s*:/);
    }
    // At rest: the wash at its faintest, and a hairline.
    const rest = all.filter((item) => item.selector === ".chain-tile");
    expect(rest.map((item) => item.body).join("\n")).toMatch(/border: var\(--border-width\) solid var\(--border\);/);
    expect(rest.map((item) => item.body).join("\n")).toMatch(/background: color-mix\(in srgb, var\(--chain-colour\) 8%, transparent\);/);
  });

  it("a chain's colour is data, handed to its tile: every chain has one, and no stylesheet holds any of them", () => {
    for (const key of CHAINS.keys()) expect(CHAIN_COLOURS[key], key).toMatch(/^#[0-9a-f]{6}$/);
    // A chain the list does not know still gets a tone, so its tile is never without a wash.
    expect(chainColour("some-new-chain")).toMatch(/^#[0-9a-f]{6}$/);
    expect(chainColour("bsc")).toBe(CHAIN_COLOURS.bsc);
    // The tile sets the colour itself, as a property the stylesheet reads.
    const picker = fs.readFileSync(path.join(stylesDir, "components", "CoinPicker.tsx"), "utf8");
    expect(picker).toMatch(/style=\{\{ "--chain-colour": chainColour\(chain\) \} as CSSProperties\}/);
    for (const [name, css] of sheets) for (const colour of new Set(Object.values(CHAIN_COLOURS))) expect(css.toLowerCase().includes(colour), `${name} holds ${colour}`).toBe(false);
  });

  it("the page notes the keyboard only for Tab and the arrow keys, and forgets it at any press of a pointer and at Escape", () => {
    const keys = fs.readFileSync(path.join(stylesDir, "lib", "keys.ts"), "utf8");
    expect(keys).toMatch(/const MOVES = new Set\(\["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"\]\);/);
    expect(keys).toMatch(/if \(event\.key === "Escape"\) \{\s*delete root\.dataset\.keys;/);
    expect(keys).toMatch(/const pointer = \(\) => \{\s*moving = false;\s*delete root\.dataset\.keys;/);
    // A move of the focus that is not one of those keys' doing (a sheet opening or closing) takes the note away too.
    expect(keys).toMatch(/const focus = \(\) => \{\s*if \(!moving\) delete root\.dataset\.keys;/);
  });
});

describe("components use tokens only", () => {
  const files = cssFiles(stylesDir).filter((file) => !file.endsWith(path.join("styles", "tokens.css")));
  // 1280 px is where the documentation has room for a third column.
  const BREAKPOINTS = new Set(["360px", "480px", "768px", "1024px", "1280px"]);

  it("finds the stylesheets", () => {
    expect(files.length).toBeGreaterThan(1);
  });

  it.each(files.map((file) => [path.relative(stylesDir, file), file] as const))("%s has no raw colour, size or radius", (_name, file) => {
    const css = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const problems: string[] = [];
    for (const line of css.split("\n")) {
      const text = line.trim();
      if (text === "" || text.startsWith("@font-face") || text.startsWith("src:")) continue;
      if (text.startsWith("@media")) {
        // Media queries cannot read variables; only the four agreed breakpoints may appear.
        for (const px of text.match(/\d+(\.\d+)?px/g) ?? []) if (!BREAKPOINTS.has(px)) problems.push(`breakpoint ${px}: ${text}`);
        continue;
      }
      if (/#[0-9a-f]{3,8}\b/i.test(text)) problems.push(`raw colour: ${text}`);
      if (/\b(rgb|rgba|hsl|hsla|oklch|lab)\(/.test(text)) problems.push(`raw colour: ${text}`);
      // Any length must come from a token. Zero, percentages, fractions and unitless numbers are fine.
      const withoutVars = text.replace(/var\(--[a-z0-9-]+\)/g, "");
      if (/(?<![\w.-])\d*\.?\d+(px|rem|em|pt|vh|vw|dvh|ch)\b/.test(withoutVars) && !/animation-duration: 0\.01ms/.test(text)) problems.push(`raw size: ${text}`);
      if (/(?<![\w-])\d+m?s\b/.test(withoutVars) && !/0\.01ms/.test(text)) problems.push(`raw duration: ${text}`);
    }
    expect(problems).toEqual([]);
  });

  it("every variable a stylesheet uses is defined in the token file", () => {
    const defined = new Set([...tokensCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const missing = new Set<string>();
    for (const file of files) {
      const css = fs.readFileSync(file, "utf8");
      const local = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
      for (const match of css.matchAll(/var\((--[a-z0-9-]+)/g)) if (!defined.has(match[1]) && !local.has(match[1])) missing.add(`${path.relative(stylesDir, file)}: ${match[1]}`);
    }
    expect([...missing]).toEqual([]);
  });
});

describe("only transform and opacity are ever animated", () => {
  // Anything else that changed over time could move the page's
  // layout or cost a slow phone its sixty frames a second. Colours change at once.
  const ALLOWED = new Set(["transform", "opacity"]);
  const files = cssFiles(stylesDir);
  // The first exception: the quote on the swap card opens with
  // a smooth height animation. A height is animated in two rules of the card's stylesheet, both in
  // answer to something the person has just done, and nowhere else.
  const HEIGHT = { file: path.join("styles", "card.css"), property: "grid-template-rows", rules: [".quote", ".quote-more"] };
  // The second, and the last: the swap card's own height, as its contents change places with the coin
  // picker and back. One rule of the card's stylesheet, in answer to something the person has just
  // done (opening the picker, or leaving it), and nowhere else. The card's top edge and its width stay
  // where they are, so nothing above or beside the card moves.
  const CARD_HEIGHT = { file: path.join("styles", "card.css"), property: "height", rules: [".card"] };

  it.each(files.map((file) => [path.relative(stylesDir, file), file] as const))("%s", (_name, file) => {
    const css = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const problems: string[] = [];
    for (const match of css.matchAll(/(?<![\w-])transition(-property)?\s*:\s*([^;}]+)[;}]/g)) {
      const value = match[2]!.trim();
      if (value === "none") continue;
      for (const part of value.split(",")) {
        const property = part.trim().split(/\s+/)[0]!;
        if (property === HEIGHT.property && file.endsWith(HEIGHT.file)) continue;
        if (property === CARD_HEIGHT.property && file.endsWith(CARD_HEIGHT.file)) continue;
        if (!ALLOWED.has(property)) problems.push(`a transition of "${property}"`);
      }
    }
    for (const block of css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)) {
      for (const declaration of block[2]!.matchAll(/([a-z-]+)\s*:/g)) {
        // A keyframe may say how the stretch after it eases; that moves nothing by itself.
        if (!ALLOWED.has(declaration[1]!) && declaration[1] !== "animation-timing-function") problems.push(`@keyframes ${block[1]} changes "${declaration[1]}"`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("a height is animated only where the swap card's quote opens", () => {
    const css = fs.readFileSync(path.join(stylesDir, HEIGHT.file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/(?<=^|[{}])\s*([^{}@]+?)\s*\{([^{}]*)\}/g)].filter((match) => /transition:[^;]*grid-template-rows/.test(match[2]!)).map((match) => match[1]!.trim());
    expect(rules).toEqual(HEIGHT.rules);
    // And where the system asks for less movement, not even there.
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.quote,\s*\.quote-more,[^}]*\{\s*transition: none;/);
  });

  it("the card's own height is animated only where the swap and the coin picker change places", () => {
    const css = fs.readFileSync(path.join(stylesDir, CARD_HEIGHT.file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const all = [...css.matchAll(/(?<=^|[{}])\s*([^{}@]+?)\s*\{([^{}]*)\}/g)].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));
    // One rule, and in it the height alone, for as long as a sheet takes.
    const animated = all.filter((rule) => /transition(-property)?:[^;]*(?<![\w-])height/.test(rule.body));
    expect(animated.map((rule) => rule.selector)).toEqual(CARD_HEIGHT.rules);
    expect(animated[0]!.body).toMatch(/transition: height var\(--motion-sheet\) var\(--ease-out\);/);
    // No stylesheet sets the card's height: the page gives it two heights for the length of the change and takes them away again.
    for (const rule of all.filter((item) => item.selector.split(",").some((part) => /^\.card(\[[^\]]*\])*$/.test(part.trim())))) expect(rule.body, rule.selector).not.toMatch(/(?<![\w-])(?:min-|max-)?height:/);
    expect(fs.readFileSync(path.join(stylesDir, "components", "SwapCard.tsx"), "utf8")).toMatch(/const settle = \(\) => \{\s*if \(element !== null\) element\.style\.height = "";/);
    // No other stylesheet animates a height of any kind.
    for (const file of files.filter((name) => !name.endsWith(CARD_HEIGHT.file))) expect(fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""), file).not.toMatch(/transition(-property)?:[^;]*(?<![\w-])height/);
    // And where the system asks for less movement, not even there: nothing slides, and the card is at once the height of the view it shows.
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.card,\s*\.card-view \{\s*transition: none;\s*\}\s*\.card-picker \{\s*animation: none;\s*\}\s*\}/);
    expect(fs.readFileSync(path.join(stylesDir, "components", "SwapCard.tsx"), "utf8")).toMatch(/if \(element === null \|\| window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches\) \{\s*settle\(\);\s*return;/);
  });

  it("the swap and the coin picker change places by sliding: a move and a fade, and nothing else", () => {
    const css = fs.readFileSync(path.join(stylesDir, CARD_HEIGHT.file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.card-view \{[^}]*transition: transform var\(--motion-sheet\) var\(--ease-out\), opacity var\(--motion-sheet\) var\(--ease-out\);/);
    expect(css).toMatch(/@keyframes card-view-in \{\s*from \{\s*opacity: 0;\s*transform: translateX\([^;]+\);\s*\}\s*\}/);
    // The time the page waits before it lets the card's height go is the time the slide takes.
    expect(tokensCss).toMatch(/--motion-sheet: 250ms;/);
    expect(fs.readFileSync(path.join(stylesDir, "components", "SwapCard.tsx"), "utf8")).toMatch(/const SLIDE_MS = 250;/);
  });

  it("is a check that can fail", () => {
    const sample = "a { transition: background 1s; } @keyframes grow { to { height: 10px; } }";
    expect([...sample.matchAll(/(?<![\w-])transition(-property)?\s*:\s*([^;}]+)[;}]/g)].map((match) => match[2]!.trim().split(/\s+/)[0])).toEqual(["background"]);
    expect([...sample.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)].map((block) => block[1])).toEqual(["grow"]);
  });

  it("the stage waits under the pointer: its pause is written as fully as the rule that sets it running, so it is not undone by it", () => {
    const home = fs.readFileSync(path.join(stylesDir, "styles", "home.css"), "utf8");
    expect(home).toMatch(/\.stage\[data-running\] \.stage-tab\[aria-selected="true"\] \.stage-progress-fill \{\s*animation: stage-fill var\(--stage-dwell\) linear both;/);
    expect(home).toMatch(/\.stage\[data-running\]\[data-waiting\] \.stage-tab\[aria-selected="true"\] \.stage-progress-fill \{\s*animation-play-state: paused;/);
  });

  it("uses the set easing and durations", () => {
    const vars = Object.fromEntries([...tokensCss.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2]!.trim()]));
    expect(vars["--ease-out"]).toBe("cubic-bezier(0.2, 0.8, 0.2, 1)");
    const ms = (name: string) => Number.parseInt(vars[name] ?? "", 10);
    for (const name of ["--motion-fast", "--motion-base", "--motion-sheet"]) {
      expect(ms(name), name).toBeGreaterThanOrEqual(150);
      expect(ms(name), name).toBeLessThanOrEqual(250);
    }
    for (const name of ["--motion-reveal", "--motion-draw"]) {
      expect(ms(name), name).toBeGreaterThanOrEqual(400);
      expect(ms(name), name).toBeLessThanOrEqual(700);
    }
    expect(vars["--stagger"]).toBe("60ms");
    expect(vars["--stagger-word"]).toBe("40ms");
    expect(vars["--rise"]).toBe("16px");
    expect(vars["--press"]).toBe("0.98");
    expect(vars["--stage-dwell"]).toBe("6s");
  });
});

