// Shows what closing a week of points would do, and closes it when told to. Run by hand, by the operator.
//
//   npm run rewards:export -- --week 2026-W41 --pool 12.5            a look: it writes nothing
//   npm run rewards:export -- --week 2026-W41 --pool 12.5 --close    closes the week
//
// The pool is an amount of NEAR (the coin rewards are paid in: NEAR on BNB Chain, by the reward
// token's contract, REWARD_TOKEN_ADDRESS), and every figure it works out is in that token's own
// smallest unit.
//
// It shares the pool out among the week's rewards addresses by their points, in whole-number
// maths, each share rounded down; what is left over stays in the reserve. A share under the
// smallest payout is not sent: its points are carried into the next week. Every address that is
// due a payout is screened against the sanctions list (the list the server screens orders with):
// a listed address is sent nothing, and what it would have had stays in the reserve.
//
// Without --close it prints all of that and writes nothing, so the pool can be looked at before it
// is fixed. With --close it first reads what the reserve wallet holds from BNB Chain, and closes
// nothing if the pool is more than that or the balance cannot be read. Then it writes the week's
// record and, beside the data, rewards/exports/<week>.csv and <week>.summary.json. Running it again
// for the same week and pool writes the same files; a closed week cannot be closed again with
// another pool. A week is closed only once every earlier week that holds points has been; a week
// nothing is to be paid for is closed with --pool 0, and its points are carried forward.
// It sends nothing: the payouts themselves are sent from the reserve wallet by hand.

import fs from "node:fs";
import path from "node:path";
import { formatExact } from "../shared/amounts.ts";
import { RESERVE_ASSET } from "../shared/rewards.ts";
import { loadConfig } from "../server/config.ts";
import type { Logger } from "../server/log.ts";
import { createRewards } from "../server/rewards.ts";
import { exportWeek, poolAmount, rewardTokenDecimals } from "../server/rewards-tools.ts";
import { createRpc } from "../server/rpc.ts";
import { createSanctions } from "../server/sanctions.ts";

function option(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : (process.argv[at + 1] ?? null);
}

const say = (line: string) => console.log(`rewards:export: ${line}`);

try {
  const week = option("week");
  const pool = option("pool");
  const asset = option("asset") ?? RESERVE_ASSET.symbol;
  const close = process.argv.includes("--close");
  if (week === null || pool === null) throw new Error("Usage: npm run rewards:export -- --week 2026-W41 --pool 12.5 [--close]");
  const config = loadConfig(process.env);
  const rpc = createRpc({ urls: config.rpcUrls });
  // The token's own decimals: the pool is typed as an amount of it, and is worked in its smallest unit.
  const decimals = await rewardTokenDecimals(rpc, config.rewardTokenAddress);
  if (decimals === null) throw new Error("The reward token's decimals could not be read from BNB Chain, so the pool's amount cannot be worked out. Nothing was done. Try again shortly.");
  const amount = { raw: poolAmount(pool, decimals) };

  // The sanctions list the server screens orders with: the copy saved in the data folder, fetched
  // again when it is more than a day old. A person is at the keyboard, so nothing is sent to the
  // alert channel from here; what matters is said on the screen.
  const log: Logger = {
    info() {},
    warn() {},
    error(event) {
      if (event === "sanctions_refresh_failed") console.error("rewards:export: the sanctions list could not be fetched just now. The saved copy is used if it is recent enough.");
    },
  };
  const sanctions = createSanctions({ dataDir: config.dataDir, log, alerts: { send() {} } });
  await sanctions.refresh();

  const result = await exportWeek({ rewards: createRewards(config.dataDir), sanctions, rpc, reserve: config.reserveAddress, token: { address: config.rewardTokenAddress, decimals }, week, pool: amount.raw, asset, now: Date.now(), close });
  const holds = result.reserveHolds === null ? null : formatExact(result.reserveHolds, decimals);

  if (result.already) say(`week ${week} is closed already. This is its record.`);
  else if (result.closed) say(`week ${week} closed.`);
  else say(`week ${week}: what closing it with this pool would do. Nothing was written.`);
  console.log(JSON.stringify(result.summary, null, 2));
  console.log(result.csv.trimEnd());
  if (result.summary.addressesWithheld > 0) say(`${result.summary.addressesWithheld} address(es) due a payout are on the sanctions list. Nothing is sent to them: what was kept back is in the last column.`);

  if (!result.closed) {
    if (config.reserveAddress === null) say("RESERVE_ADDRESS is not set. Closing needs it, to check the pool against what the reserve holds.");
    else if (holds === null) say("the reserve wallet's balance could not be read from BNB Chain just now. Closing needs it.");
    else if (result.reserveHolds !== null && amount.raw > result.reserveHolds) say(`the reserve wallet holds ${holds} ${RESERVE_ASSET.symbol}, which is less than this pool. Closing with it would be refused.`);
    else say(`the reserve wallet holds ${holds} ${RESERVE_ASSET.symbol}.`);
    say("to close the week with this pool, run the same command again with --close at the end.");
  } else if (close) {
    const dir = path.join(config.dataDir, "rewards", "exports");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `${week}.csv`), result.csv, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, `${week}.summary.json`), `${JSON.stringify(result.summary, null, 2)}\n`, { mode: 0o600 });
    say(`wrote rewards/exports/${week}.csv and ${week}.summary.json in the data folder.`);
    say("send each payout on the list from the reserve wallet: one transfer for each address, for exactly its amount.");
    say(`then record them: npm run rewards:record -- --week ${week} --tx <hash> [--tx <hash> …]`);
  }
} catch (error) {
  console.error(`rewards:export: ${(error as Error).message}`);
  process.exit(1);
}
