// A page left open across a new version of the site: when one of its late-loaded parts is gone,
// the page loads itself again once, and after that asks instead of reloading in a loop.

import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { forgetFailures, isLoadFailure, partFailedToLoad, watchForNewVersion } from "../web/src/lib/stale.ts";

function page(start = 1_000_000) {
  const kept = new Map<string, string>();
  const state = { reloads: 0, now: start };
  const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) };
  return { state, kept, around: { storage, reload: () => void (state.reloads += 1), now: () => state.now } };
}

beforeEach(() => forgetFailures());

describe("a part of the site that fails to load", () => {
  it("reloads the page once, and a second failure straight after asks for a reload instead", () => {
    const first = page();
    expect(partFailedToLoad(first.around)).toBe("reloading");
    expect(first.state.reloads).toBe(1);
    // The page has loaded again (what it noted survives in the tab) and the part still fails: no second reload.
    forgetFailures();
    first.state.now += 3_000;
    expect(partFailedToLoad(first.around)).toBe("ask");
    expect(partFailedToLoad(first.around)).toBe("ask");
    expect(first.state.reloads).toBe(1);
    // Long after, in the same tab, another new version may be out: one reload again.
    forgetFailures();
    first.state.now += 10 * 60_000;
    expect(partFailedToLoad(first.around)).toBe("reloading");
    expect(first.state.reloads).toBe(2);
    // Where nothing can be noted, a reload could not be told from a loop of them: the page asks at once.
    forgetFailures();
    const blind = page();
    expect(partFailedToLoad({ ...blind.around, storage: null })).toBe("ask");
    const refusing = { getItem: () => null, setItem: () => { throw new Error("no room"); } };
    forgetFailures();
    expect(partFailedToLoad({ ...blind.around, storage: refusing })).toBe("ask");
    expect(blind.state.reloads).toBe(0);
    // Nothing a person typed is ever what is noted: one fixed key, holding a time.
    expect([...first.kept.keys()]).toEqual(["reloaded-for-new-version"]);
    expect([...first.kept.values()].every((value) => /^\d+$/.test(value))).toBe(true);
  });

  it("is heard for every late-loaded part, and is told apart from a sign-in the server refused", () => {
    const heard: Array<() => void> = [];
    const stop = watchForNewVersion({ addEventListener: (name: string, listener: () => void) => void (name === "vite:preloadError" && heard.push(listener)), removeEventListener: () => undefined } as never);
    expect(heard).toHaveLength(1);
    stop();
    for (const text of ["Failed to fetch dynamically imported module: https://example.org/assets/sign-in-abc.js", "error loading dynamically imported module", "Importing a module script failed.", "Unable to preload CSS for /assets/docs-1.css"]) expect(isLoadFailure(new TypeError(text)), text).toBe(true);
    for (const other of [new Error("That sign-in did not work."), new Error("User rejected the request"), "nothing", null]) expect(isLoadFailure(other), String(other)).toBe(false);
    // The Rewards page: a sign-in module that cannot be fetched says nothing of a sign-in that was never tried.
    const rewards = fs.readFileSync(path.resolve("web", "src", "stores", "rewards.ts"), "utf8");
    expect(rewards).toMatch(/\(\{ signPlainMessage \} = await import\("\.\.\/wallet\/sign-in\.ts"\)\);\s*\} catch \{\s*partFailedToLoad\(\);\s*set\(\{ step: "idle", error: null \}\);\s*return;/);
    // The page watches from its first moment, and its pages' own boundary answers the same way.
    expect(fs.readFileSync(path.resolve("web", "src", "main.tsx"), "utf8")).toContain("watchForNewVersion();");
    expect(fs.readFileSync(path.resolve("web", "src", "App.tsx"), "utf8")).toContain("if (isLoadFailure(error)) partFailedToLoad();");
  });
});
