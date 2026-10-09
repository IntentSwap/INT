// Starts the server (port 8787) and the Vite dev server together.
// Local development never creates a real order at the swap provider.
// Set PROVIDER_STUB=true to practise the whole flow with pretend orders.
//
// Variables are read from a local .env file when there is one (it is
// git-ignored). Anything already set in the shell wins over the file.

import { spawn, type ChildProcess } from "node:child_process";

const env = { ...process.env, NODE_ENV: "development" };
const children: ChildProcess[] = [
  spawn("npx", ["tsx", "watch", "--clear-screen=false", "--env-file-if-exists=.env", "server/index.ts"], { stdio: "inherit", env }),
  spawn("npx", ["vite", "--config", "web/vite.config.ts"], { stdio: "inherit", env }),
];

let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}

for (const child of children) child.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
