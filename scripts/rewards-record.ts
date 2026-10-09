// Records the transactions that paid a closed week, so that the Rewards page can show them. Run by
// hand, by the operator, after the payouts have been sent from the reserve wallet.
//
//   npm run rewards:record -- --week 2026-W41 --tx 0x… [--tx 0x… …]
//
// Each transaction is checked on BNB Chain first. It must have been sent by the reserve wallet
// (RESERVE_ADDRESS) and have gone through, and it counts only for what it holds: a transfer of NEAR
// (the reward token, REWARD_TOKEN_ADDRESS) from the reserve wallet to an address on the week's list, for exactly that address's
// payout, where none is on record for it yet. The hash is written down with the payout it made. A
// transaction that holds no such transfer, or that is on record already for any week, is refused.
// If any one does not pass, nothing is recorded.

import { loadConfig } from "../server/config.ts";
import { createRewards } from "../server/rewards.ts";
import { recordPayouts } from "../server/rewards-tools.ts";
import { createRpc } from "../server/rpc.ts";

function options(name: string): string[] {
  const found: string[] = [];
  process.argv.forEach((arg, at) => {
    const value = process.argv[at + 1];
    if (arg === `--${name}` && value !== undefined) found.push(value);
  });
  return found;
}

try {
  const [week] = options("week");
  const hashes = options("tx");
  if (week === undefined || hashes.length === 0) throw new Error("Usage: npm run rewards:record -- --week 2026-W41 --tx 0x… [--tx 0x… …]");
  const config = loadConfig(process.env);
  if (config.reserveAddress === null) throw new Error("RESERVE_ADDRESS is not set, so there is no reserve wallet to check the transactions against.");
  const record = await recordPayouts({ rewards: createRewards(config.dataDir), rpc: createRpc({ urls: config.rpcUrls }), reserve: config.reserveAddress, token: config.rewardTokenAddress, week, hashes, now: Date.now() });
  const due = record.shares.filter((share) => BigInt(share.payout) > 0n);
  const sent = due.filter((share) => share.tx !== undefined).length;
  console.log(`rewards:record: week ${week}: ${sent} of ${due.length} payout(s) now have their transaction on record.`);
  if (sent < due.length) console.log(`rewards:record: ${due.length - sent} still to be sent or recorded.`);
} catch (error) {
  console.error(`rewards:record: ${(error as Error).message}`);
  process.exit(1);
}
