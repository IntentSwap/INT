// Every visit starts in the light theme, for everyone: whatever the device prefers, and whatever
// was chosen on an earlier visit. The dark theme can be chosen, and lasts until the page is loaded again.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const page = fs.readFileSync(path.resolve("web", "index.html"), "utf8");
const source = fs.readFileSync(path.resolve("web", "src", "theme.ts"), "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the theme a visit starts in", () => {
  it("is light, set before anything is drawn, and asks neither the device nor an earlier visit", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
    expect(script).toContain('document.documentElement.dataset.theme = "light";');
    // Nothing else in the page, and nothing in the theme's own code, could start it any other way.
    for (const text of [page, source]) {
      expect(text).not.toMatch(/localStorage|matchMedia|prefers-color-scheme|cookie/);
      expect(text).not.toMatch(/dataset\.theme = "dark"/);
    }
    expect(source).not.toMatch(/sessionStorage/);
    // The page's first script reads one thing that a tab has kept, once, and it is not the theme: the flag of Ghost mode.
    // The theme is set after that, outside it, whatever the flag says.
    expect(page.match(/sessionStorage/g)).toHaveLength(1);
    expect(script).toContain('if (sessionStorage.getItem("ghost") === "on") {');
    expect(script.indexOf("} catch (error) {")).toBeGreaterThan(script.indexOf("sessionStorage"));
    expect(script.indexOf('document.documentElement.dataset.theme = "light";')).toBeGreaterThan(script.indexOf("} catch (error) {"));
    // The browser's own parts (scroll bars, form controls) are told light first.
    expect(page).toContain('<meta name="color-scheme" content="light dark" />');
  });

  it("can be switched to dark and back for the length of the visit, and keeps nothing", async () => {
    const dataset: Record<string, string> = { theme: "light" };
    const touched: string[] = [];
    const storage = new Proxy({}, { get: (_target, name) => (...args: unknown[]) => void touched.push(`${String(name)}(${args.join(",")})`) });
    vi.stubGlobal("document", { documentElement: { dataset } });
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    const { getTheme, onThemeChange, setTheme } = await import("../web/src/theme.ts");
    expect(getTheme()).toBe("light");
    let told = 0;
    const stop = onThemeChange(() => (told += 1));
    setTheme("dark");
    expect([dataset.theme, getTheme(), told]).toEqual(["dark", "dark", 1]);
    setTheme("light");
    expect([dataset.theme, getTheme(), told]).toEqual(["light", "light", 2]);
    stop();
    setTheme("dark");
    expect(told).toBe(2);
    // Nothing was read from or written to the browser's storage: a new load of the page knows nothing of the choice.
    expect(touched).toEqual([]);
    // A page with no theme set at all, or with anything but "dark", is light.
    for (const value of [undefined, "", "Dark", "system"]) {
      if (value === undefined) delete dataset.theme;
      else dataset.theme = value;
      expect(getTheme(), String(value)).toBe("light");
    }
  });
});
