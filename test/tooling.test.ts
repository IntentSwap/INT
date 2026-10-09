// The developer's machine, the automatic check and the host all install with the same npm: the one
// named in package.json. A lockfile made by one npm can lack entries another insists on, and a
// clean install then fails wherever the other is used, so the version is said once and used everywhere.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (...parts: string[]) => fs.readFileSync(path.resolve(...parts), "utf8");
const manifest = JSON.parse(read("package.json")) as { packageManager?: string; engines?: { node?: string }; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const pinned = /^npm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? "")?.[1] ?? "";

describe("one npm for the developer's machine, the automatic check and the host", () => {
  it("package.json names it exactly, beside the Node it runs on", () => {
    expect(manifest.packageManager).toMatch(/^npm@\d+\.\d+\.\d+$/);
    expect(manifest.engines?.node).toBe(">=24 <25");
  });

  it("the automatic check installs that npm before it installs anything from the lockfile, and runs no package scripts", () => {
    const workflow = read(".github", "workflows", "ci.yml");
    const use = workflow.indexOf(`run: npm install --global npm@${pinned}`);
    const install = workflow.indexOf("run: npm ci --ignore-scripts");
    expect(use).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(use);
    // No other npm is named there, and nothing is installed any other way.
    expect([...workflow.matchAll(/npm@(\d+\.\d+\.\d+)/g)].map((match) => match[1])).toEqual([pinned]);
    expect(workflow).not.toMatch(/npm install(?! --global npm@)|npm i\b/);
    // It needs no secret of the project's: none is named, and it may only read the repository.
    expect(workflow).not.toMatch(/secrets\.|ONECLICK_API_KEY/);
    expect(workflow).toMatch(/permissions:\n\s+contents: read/);
  });

  it("the README's deploy steps make the host install with the same npm", () => {
    expect(read("README.md")).toContain(`Custom Build Command: \`npm install --global npm@${pinned} && npm ci --ignore-scripts && npm run build\``);
  });

  it("a script tries a clean install under the pinned npm, an older one and the newest, before a push", () => {
    expect(manifest.scripts?.["check:lock"]).toBe("tsx scripts/check-lock.ts");
    const script = read("scripts", "check-lock.ts");
    expect(script).toContain('["-y", `npm@${version}`, "ci", "--ignore-scripts", "--dry-run"]');
    expect(script).toContain('const OTHERS = ["10.9.2", "latest"];');
    expect(script).toContain("for (const version of [pinned, ...OTHERS])");
    // It works on a copy of the three files an install reads, never in the project itself.
    expect(script).toContain('for (const file of ["package.json", "package-lock.json", ".npmrc"]) fs.copyFileSync(path.resolve(file), path.join(copy, file));');
    expect(script).toContain("{ cwd: copy,");
  });

  it("every package is named at one exact version, and the lockfile is the one for this package.json", () => {
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) expect(version, name).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    const lock = JSON.parse(read("package-lock.json")) as { lockfileVersion: number; packages: Record<string, { version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }> };
    expect(lock.lockfileVersion).toBe(3);
    // The lockfile's own record of what package.json asks for is what package.json asks for.
    expect(lock.packages[""]?.dependencies ?? {}).toEqual(manifest.dependencies ?? {});
    expect(lock.packages[""]?.devDependencies ?? {}).toEqual(manifest.devDependencies ?? {});
    // And every package asked for directly is in it at that very version.
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version);
  });
});

describe("the page-measuring step of the automatic check", () => {
  const script = fs.readFileSync(path.resolve("scripts", "page-quality.ts"), "utf8");

  it("fails for speed on a developer's machine only: on GitHub's shared machines the speed score and the paint time warn, and do not fail the run", () => {
    expect(script).toContain('const sharedMachine = process.env.GITHUB_ACTIONS === "true";');
    expect(script).toContain("const bySpeed = sharedMachine ? warnings : problems;");
    expect(script).toMatch(/\(name === "performance" \? bySpeed : problems\)\.push\(/);
    expect(script).toMatch(/paint > LATEST_PAINT_MS\) bySpeed\.push\(/);
    // A warning is only ever printed: nothing but a problem ends the run badly.
    expect(script).toContain("for (const warning of warnings) console.log(`::warning title=Page speed on this machine::${warning}`);");
    expect(script).not.toMatch(/warnings\.length/);
    expect(script).toMatch(/if \(problems\.length > 0\) \{\n[^\n]*console\.error[^\n]*\n {2}process\.exit\(1\);/);
  });

  it("fails everywhere for what gives the same answer every time: the accessibility rules and layout shift, with the budgets as they were", () => {
    expect(script).toContain("const LEAST = { performance: 90, accessibility: 100 } as const;");
    expect(script).toContain("const MOST_SHIFT = 0.05;");
    expect(script).toContain("const LATEST_PAINT_MS = 3_500;");
    expect(script).toMatch(/shift > MOST_SHIFT\) problems\.push\(/);
    expect(script).toMatch(/audit\.score < 1\) problems\.push\(/);
    expect(script).toMatch(/for \(const problem of await axeProblems\(tab\)\) problems\.push\(/);
  });

  it("measures the Stats page wherever the site has one", () => {
    expect(script).toContain('if (config.statsPage === true) pages.push("/stats");');
  });
});
