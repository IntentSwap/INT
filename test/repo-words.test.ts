import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// What is published describes the product: what the code does, and why. A comment, a test's
// title or a line of the README states the rule or the fact itself. It does not point at a file
// of notes, cite a note by its number, or say whose wish something was.
//
// Each pattern below is put together from parts, as is each sentence it is tried on, so that this
// file does not hold what it looks for.

const join = (...parts: string[]) => parts.join("");

/** What is never written, each with a few words for the message when it is found. */
const NEVER: readonly (readonly [string, RegExp])[] = [
  ["a pointer to a file of notes", new RegExp(join("do", "cs/", "(?:progress|decisions|owner-todo|verified|report|owner-instructions|design-patterns|phase-two)"))],
  [join("the word ", "hand", "over"), new RegExp(join("hand", "over"), "i")],
  ["a note cited by its number", new RegExp(join("\\b", "D", "\\d{1,2}(?:\\.\\d+)?\\b"))],
  ["whose wish something was", new RegExp(join("the own", "er's (?:instruction|rule|exception|message|note|decision|fourth message|words)"), "i")],
  ["how the code was looked over", new RegExp(join("security rev", "iew|design rev", "iew|rev", "iewer"), "i")],
  // Whoever runs the site is "the operator"; the logo is "the project's logo" or "the supplied artwork".
  ["a word for whoever the project belongs to", new RegExp(join("\\bthe own", "er\\b|\\bown", "er's\\b"), "i")],
];

/** One sentence of each kind, in the order of the list above. */
const CAUGHT = [
  join("the reasons are in do", "cs/decisions.md"),
  join("as the Hand", "over says"),
  join("inline styles are allowed (D", "43)"),
  join("by the own", "er's rule, nothing is outlined"),
  join("found in the security rev", "iew"),
  join("the mark is the own", "er's logo"),
];

/** Sentences that say a fact or a rule, and words of the product that only look alike. */
const PLAIN = [
  "The server sets the fee and the deposit address.",
  "Spellings checked against the real database on 8 Oct 2026.",
  "a sample token and reserve where the operator has set none",
  "Each mark belongs to its owner.",
  "the review sheet shows the address in its standard spelling",
  "the Docs page at /docs/fees",
  "0xD1d1D1d1D1d1D1d1D1d1D1d1D1d1D1d1D1d1D1d1",
  "3D1 is no number of a note, and neither is ID12",
];

/** The text files that are published: the kinds of file a person reads or a tool runs. */
const TEXT = /\.(?:ts|tsx|css|html|md|json|ya?ml|mjs|example)$/;
const PLACES = ["README.md", ".env.example", "server", "shared", path.join("web", "src"), path.join("web", "index.html"), path.join("web", "vite.config.ts"), "scripts", "test", ".github"];
const walk = (target: string): string[] => (fs.statSync(target).isDirectory() ? fs.readdirSync(target).flatMap((entry) => walk(path.join(target, entry))) : TEXT.test(target) ? [target] : []);
const name = (file: string) => path.relative(path.resolve("."), file).split(path.sep).join("/");
/** A file's text with its line breaks taken out, and the comment marks that follow them, so that a sentence written over two lines is read as one. */
const flat = (text: string) => text.replace(/[ \t]*\r?\n[ \t]*(?:\/\/+|\*|#)?[ \t]*/g, " ");
/** Everything in a text that is never written, each with what it is. */
const found = (text: string) => NEVER.flatMap(([what, pattern]) => [...flat(text).matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].map((match) => `${what}: "${match[0]}"`));

describe("what is published says what the product does, and nothing of how it came to be", () => {
  it("is a check that can fail: each pattern finds a sentence of its kind, and leaves a plain one alone", () => {
    expect(CAUGHT).toHaveLength(NEVER.length);
    NEVER.forEach(([what, pattern], index) => {
      expect(pattern.test(CAUGHT[index]!), what).toBe(true);
      // (A sentence may be of two kinds at once; it is found as this kind among them.)
      expect(found(CAUGHT[index]!).filter((hit) => hit.startsWith(`${what}:`)), what).toHaveLength(1);
    });
    for (const sentence of PLAIN) expect(found(sentence), sentence).toEqual([]);
    // A sentence broken over two lines of a comment is still found.
    // (This one is two things at once: whose wish it was, and the word for whose.)
    expect(found(join("// as the own", "er's\n// instruction has it"))).toHaveLength(2);
    expect(found(join("where the own", "er has set none"))).toHaveLength(1);
    expect(found(join(" * each entry is explained in do", "cs/decisions.md\n * (D", "43)."))).toHaveLength(2);
  });

  it("holds in every text file of the repository", () => {
    const files = PLACES.flatMap((place) => walk(path.resolve(place)));
    // The walk reaches what it should: the pages of words, the code, the scripts, the tests (this one among them) and the workflow.
    for (const expected of ["README.md", ".env.example", "web/index.html", "web/vite.config.ts", "server/app.ts", "shared/rewards.ts", "web/src/styles/tokens.css", "scripts/mutation-check.ts", "test/repo-words.test.ts", ".github/workflows/ci.yml"]) {
      expect(files.map(name), expected).toContain(expected);
    }
    expect(files.length).toBeGreaterThan(150);
    const hits = files.flatMap((file) => found(fs.readFileSync(file, "utf8")).map((hit) => `${name(file)}: ${hit}`));
    expect(hits).toEqual([]);
  });
});
