// Checks, before a push, that the lockfile is complete: that a clean install from it would be
// accepted. Nothing is installed (it is a dry run), and nothing in the project is touched: the
// three files an install reads are copied to a folder of their own first, as a fresh copy of the
// repository would have them.
//
//   npm run check:lock
//
// It is tried under the npm this project is pinned to ("packageManager" in package.json, which the
// automatic check and the host install with too), and under an older npm and the newest one: each
// reads a lockfile a little differently, and a lockfile made by one can lack entries another
// insists on. One refusal fails the check. It needs the network, to fetch each npm.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** An older npm and the newest, beside the pinned one. */
const OTHERS = ["10.9.2", "latest"];

const manifest = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as { packageManager?: string };
const pinned = /^npm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? "")?.[1];
if (pinned === undefined) {
  console.error('check-lock: package.json has no "packageManager": "npm@x.y.z" line');
  process.exit(1);
}

const copy = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-lock-"));
for (const file of ["package.json", "package-lock.json", ".npmrc"]) fs.copyFileSync(path.resolve(file), path.join(copy, file));

const problems: string[] = [];
try {
  for (const version of [pinned, ...OTHERS]) {
    const run = spawnSync("npx", ["-y", `npm@${version}`, "ci", "--ignore-scripts", "--dry-run"], { cwd: copy, encoding: "utf8", timeout: 180_000 });
    const said = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    if (run.status === 0) {
      console.log(`check-lock: npm ${version}${version === pinned ? " (pinned)" : ""}: a clean install is accepted`);
      continue;
    }
    // What npm says is missing, when that is the trouble; otherwise its first line of complaint.
    const missing = [...said.matchAll(/Missing: (\S+) from lock file/g)].map((match) => match[1]);
    const why = missing.length > 0 ? `the lockfile lacks ${missing.join(", ")}` : (said.split("\n").find((line) => /npm error/i.test(line)) ?? "it could not be run").replace(/^npm error\s*/i, "");
    problems.push(`npm ${version}${version === pinned ? " (pinned)" : ""}: ${why}`);
  }
} finally {
  fs.rmSync(copy, { recursive: true, force: true });
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`check-lock: ${problem}`);
  console.error("check-lock: bring the lockfile in step (npx -y npm@10.9.2 install --package-lock-only --ignore-scripts), then run this again");
  process.exit(1);
}
console.log("check-lock: ok");
