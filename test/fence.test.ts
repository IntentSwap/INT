import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The one signature this site ever asks for is on the Rewards page (the one exception to
// "the wallet is asked for one plain transfer only"). It must never be within reach
// of the swap flow. Other tests hold that by looking for names in files. This one follows the
// site's own imports, file to file, so that a new file placed between the two cannot hide it.

const root = path.resolve("web", "src");
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(dir, entry.name)] : []));
const name = (file: string) => path.relative(root, file).split(path.sep).join("/");

/** Imports that lead to no file of the site, by any spelling. There must be none: one that is not followed is a way round the fence. */
const lost: string[] = [];

/** Where an import leads, however it is written: with its ending, without it, or as a folder with an index file. Stylesheets and the like are not code and are left out. */
function resolveImport(from: string, target: string): string | null {
  const base = path.resolve(path.dirname(from), target);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every file of the site that a file imports, whether at the top or as it goes (`import("...")`). Packages are left out. */
function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)) {
    const target = match[1]!;
    if (!target.startsWith(".")) continue;
    const resolved = resolveImport(file, target);
    if (resolved === null) lost.push(`${name(file)} imports "${target}"`);
    else if (/\.tsx?$/.test(resolved) && resolved.startsWith(root + path.sep)) found.add(resolved);
  }
  return [...found];
}

const all = files(root);
const graph = new Map(all.map((file) => [file, importsOf(file)]));
const importersOf = (target: string) => all.filter((file) => (graph.get(file) ?? []).includes(target)).map(name).sort();
/** Everything a file reaches by following imports, itself included. */
function reach(start: string): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const next of graph.get(queue.pop()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}
const at = (relative: string) => path.join(root, ...relative.split("/"));

describe("the sign-in signature is out of the swap flow's reach, by the site's own imports", () => {
  const signIn = at("wallet/sign-in.ts");

  it("reads the imports it is meant to read", () => {
    // If the pattern stopped finding imports, everything below would pass for nothing.
    expect(all.length).toBeGreaterThan(40);
    expect(importersOf(at("stores/swap.ts")).length).toBeGreaterThan(2);
    expect(reach(at("App.tsx")).has(signIn)).toBe(true);
    expect((graph.get(at("App.tsx")) ?? []).map(name)).toContain("pages/RewardsPage.tsx");
  });

  it("every import of the site's own files is followed, however it is written", () => {
    expect(lost).toEqual([]);
    // With its ending, without it, and as a folder: each spelling leads to the same file.
    const here = at("stores/rewards.ts");
    expect(resolveImport(here, "../wallet/sign-in.ts")).toBe(signIn);
    expect(resolveImport(here, "../wallet/sign-in")).toBe(signIn);
    expect(resolveImport(here, "../wallet")).toBe(at("wallet/index.ts"));
    expect(resolveImport(here, "../wallet/no-such-file")).toBeNull();
  });

  it("the signing module is imported by the Rewards page's own store, and by nothing else", () => {
    expect(importersOf(signIn)).toEqual(["stores/rewards.ts"]);
  });

  it("that store is imported by the Rewards page, and by nothing else", () => {
    expect(importersOf(at("stores/rewards.ts"))).toEqual(["pages/RewardsPage.tsx"]);
  });

  it("the Rewards page is imported by the app's own frame, and by nothing else", () => {
    expect(importersOf(at("pages/RewardsPage.tsx"))).toEqual(["App.tsx"]);
  });

  it.each(["pages/SwapPage.tsx", "pages/OrderPage.tsx", "pages/TrackPage.tsx", "components/SwapCard.tsx", "components/ReviewSheet.tsx", "components/WalletPay.tsx", "components/Shell.tsx", "wallet/transfer.ts", "wallet/index.ts", "stores/wallet.ts", "stores/swap.ts"])("nothing %s reaches, however far, is the signing module, its store or the Rewards page", (start) => {
    const reached = reach(at(start));
    for (const fenced of [signIn, at("stores/rewards.ts"), at("pages/RewardsPage.tsx")]) expect(reached.has(fenced), `${start} reaches ${name(fenced)}`).toBe(false);
  });

  it("no other file of the site asks a wallet to sign anything", () => {
    const askers = all.filter((file) => /\bsignMessage\b|\bsignTypedData\b|personal_sign|eth_sign\b|eth_signTypedData/.test(fs.readFileSync(file, "utf8"))).map(name).sort();
    // The signing module itself, and the list of what a wallet may be asked at all (which names personal_sign so that a phone wallet allows it).
    expect(askers).toEqual(["wallet/session.ts", "wallet/sign-in.ts"]);
  });
});
