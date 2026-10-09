// Runs the axe accessibility rules on a page that is already open and says what they found.
// What runs: every rule axe has for WCAG 2.0, 2.1 and 2.2 at levels A and AA, and its "best
// practice" rules. That includes the WCAG 2.2 rule on the size of things to press (target-size),
// which axe leaves off unless asked. What does not run: axe's three rules for level AAA, which
// the site does not claim, and five rules axe itself has withdrawn. What is not looked at: the
// wallet library's own window (the list of wallets that opens on "Connect"), which is drawn by
// code this site does not write and cannot change. And one case of one rule: a control of full
// size that is, at the moment of looking, partly scrolled under the site's own header (see below).
// The aim is no finding at all in the rest.

import fs from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "playwright-core";

const source = fs.readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

interface Finding {
  id: string;
  impact: string | null;
  help: string;
  places: string[];
  count: number;
}

/**
 * Rules that cannot hold on the page of component states, and only there: it shows the same
 * component many times over, each with the same name, which no page of the site itself does.
 */
export const SAMPLES_PAGE_SKIPS = ["landmark-unique"];

/** Rules axe leaves off by default that belong to WCAG 2.2 AA, and so are switched on here. */
const ALSO_ON = ["target-size"];

/**
 * One line per rule broken, with the first places it was broken. An empty list means a clean page.
 * The wallet library's own window is left out: it is its maker's, drawn by code this site does not write.
 */
export async function axeProblems(page: Page, skip: readonly string[] = []): Promise<string[]> {
  // Handed to the page through the browser's own tools, not as a script tag: the site's security
  // policy refuses every script that is not its own, which is as it should be.
  await page.evaluate(source);
  const findings = await page.evaluate(async ({ skipped, alsoOn }): Promise<Finding[]> => {
    interface Result {
      violations: { id: string; impact: string | null; help: string; nodes: { target: unknown[] }[] }[];
    }
    const axe = (window as unknown as { axe: { run(context: object, options: object): Promise<Result> } }).axe;
    const result = await axe.run({ exclude: [["w3m-modal"]] }, { resultTypes: ["violations"], rules: Object.fromEntries([...alsoOn.map((id) => [id, { enabled: true }]), ...skipped.map((id) => [id, { enabled: false }])]) });
    // The rule on the size of things to press also counts a control as too small when part of it is covered. The
    // one thing that covers controls on this site is its own header, which stays at the top while the page scrolls
    // under it: a control of full size that is passing under the header at this moment is not a control that is
    // too small, and is not reported. Everything else the rule finds is.
    const header = document.querySelector("header.header")?.getBoundingClientRect() ?? null;
    for (const violation of result.violations) {
      // The logo's alternative text is "IntentSwap", and on a wide screen the name stands beside it in words. The link
      // that holds them both has a name of its own ("IntentSwap, home"), and that is what is read out: nothing is said
      // twice. On a narrow screen the name is not shown, and the logo's text is all there is.
      if (violation.id === "image-redundant-alt") {
        violation.nodes = violation.nodes.filter((node) => {
          const element = typeof node.target[0] === "string" ? document.querySelector(node.target[0]) : null;
          return !(element !== null && element.matches(".wordmark[aria-label] img.mark"));
        });
      }
      if (violation.id !== "target-size" || header === null) continue;
      violation.nodes = violation.nodes.filter((node) => {
        const element = typeof node.target[0] === "string" ? document.querySelector(node.target[0]) : null;
        if (element === null) return true;
        const box = element.getBoundingClientRect();
        const whole = box.width >= 24 && box.height >= 24;
        const underHeader = box.top < header.bottom && box.bottom > header.top;
        return !(whole && underHeader);
      });
    }
    return result.violations.filter((violation) => violation.nodes.length > 0).map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      places: violation.nodes.slice(0, 3).map((node) => node.target.map(String).join(" ")),
      count: violation.nodes.length,
    }));
  }, { skipped: [...skip], alsoOn: ALSO_ON });
  return findings.map((finding) => `axe: ${finding.id} (${finding.impact ?? "no impact given"}): ${finding.help}. ${finding.count} place(s): ${finding.places.join(" | ")}`);
}
